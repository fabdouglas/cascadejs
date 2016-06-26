/*!
 * Cascade v0.0.1 (https://github.com/fabdouglas/cascadejs)
 * Copyright 2016 Fabrice Daugan.
 * Licensed under the MIT license
 */
define(['jquery', 'hashchange/hashchange'], function ($) {
	var $self = {

		manualDomReady: false,

		/**
		 * Current context hierarchy. Correspond to the last loaded context. $parent targets the ancestor context.
		 * @type {[type]}
		 */
		$current: null,

		/**
		 * Computed messages.
		 */
		$messages: null,

		mock: false,

		/**
		 * Current transaction identifier
		 * @type {Number}
		 */
		transaction: 0,

		/**
		 * Session, not null when has been loaded.
		 * @type {object}
		 */
		session: null,

		/**
		 * This list is filled by JavaScript modules listening for a module HTML load, and before modules's
		 * JavaScript
		 * @type {array}
		 */
		callbacks: [],

		/**
		 * Teh default view builder to use to build the view from the given context.
		 * @param  {object} context     The current context with injected '$messages', and ''$template'
		 * @return {string}             The string representing the view code to associate to the context and to inject in the correct place in the
		 *                              parent.
		 */
		viewBuilder: function (context) {
			return context.$template ? context.$template(context.$messages) : '';
		},

		/**
		 * Build an extended messages from the given messages and the parent messages discovered in the
		 * provided context.
		 */
		buildMessages: function (context, rawMessages) {
			var parentMessages = {};

			// Get the previously
			if (context.$parent) {
				parentMessages = context.$parent.$mergedMessages || {};
				// Propagate the messages to parent
				$self.propagateMessages(context.$parent, rawMessages);
			}

			// Create the messages merged from parents and future children. No injected context.
			context.$mergedMessages = {};
			$.extend(true, context.$mergedMessages, parentMessages, rawMessages);

			// Create the final merged messages and would contains injected context.
			var messages = {};
			context.$messages = messages;
			$.extend(true, messages, context.$mergedMessages);

			// Complete the messages with the context
			messages.$current = context;
			messages.$loader = $self;

			// Share thins finest messages
			$self.$messages = messages;
		},

		propagateMessages: function (context, messages) {
			$.extend(true, context.$messages, messages);
			context.$parent && $self.propagateMessages(context.$parent, messages);
		},

		/**
		 * Unload given context, its child and the siblings. Is recursive.
		 * @param  {array} context Context to unload.
		 */
		unload: function (context) {
			// First, unload children
			if (context.$siblings) {
				for (var index = 0; index < context.$siblings.length; index++) {
					$self.unload(context.$siblings[index]);
				}
				delete context.$siblings;
			}
			if (context.$child) {
				$self.unload(context.$child);
				delete context.$child;
			}

			// Unload event for the page and parent
			context.$page && (typeof context.$page.unload) === 'function' && $.proxy(context.$page.unload, context.$page)(context);
			context.$parent && (typeof context.$parent.unload) === 'function' && $.proxy(context.$parent.unload, context.$parent)(context);

			// Finally undefine the AMD modules
			$self.undef(context.$require);
			context.$unloaded = true;
			return context.$parent;
		},

		undef: function (requiredList) {
			for (var module in requiredList) {
				if ({}.hasOwnProperty.call(requiredList, module)) {
					requirejs.undef(requiredList[module]);
				}
			}
		},

		/**
		 * Return the context chain as an array.
		 * @param  {object} context A not null context.
		 * @return {array}          The context chain from root to the leaf.
		 */
		getContextHierarchy: function (context) {
			var result = [];
			while (context) {
				result.unshift(context);
				context = context.$parent;
			}
			return result;
		},

		/**
		 * Browse internally to given hash URL
		 */
		load: function (url, reload) {
			applicationManager.debug && traceDebug('browse', url);
			url = url || '';

			// Check the security
			if (typeof securityManager !== 'undefined' && !securityManager.isAllowed(url)) {
				// Check access -> Forbidden
				if (typeof errorManager === 'undefined') {
					applicationManager.debug && traceDebug('Forbidden access for URL', url);
				} else {
					errorManager.manageSecurityError(url);
				}

				// Stop the navigation
				return;
			}
			var fragments = url ? url.split('/') : [];
			// Add implicit 'main' and root fragment
			fragments.unshift('main');
			fragments.unshift('root');

			// Prepare the context
			var context = $self.$current || {
				$view: $('body'),
				$path: '',
				$url: '#/',
				$hindex: 0,
				$fragment: '',
				$siblings: [],
				$home: ''
			};

			// Create a new transaction
			var transaction = $self.newTransaction();

			// Protected zone
			require(['zone-protected'], function () {
				// First load, ensure the first level is loaded before the private/public zone
				$self.loadFragmentRecursive(context, transaction, fragments, 1, reload, function (childContext) {
					// Private zone
					require(['zone-private'], function () {
						// Load the remaining context hierarchy
						$self.loadFragmentRecursive(context.$child || childContext, transaction, fragments, 2, reload);
					});
				});
			});
		},

		/**
		 * Recursively load the remaining context hierarchy. This function is called until the last loaded context read the target index
		 * corresponding to the fragment length.
		 * Pre-condition : context.$hindex >= hindex
		 * Post-conditions : $self.$current.$hindex >= hindex
		 *
		 * @param  {object} context     The actual loaded context.
		 * @param  {array} fragments    Fragments of current URL. A not null array.
		 * @param  {integer} hindex     The context hierarchy index to validate. All previous contexts inside the hierarchy of given context
		 *                              have been validated and are loaded. Work as a cursor. A positive number.
		 * @param  {function} callback  When defined, this callback is called instead of the current function when the fragment is loaded.
		 *                              The parameters will be in the order with theses properties :
		 *                              - context : May be the same if the current hierarchy index still valid against the target fragments.
		 *                              - fragments : Same value than the original parameter.
		 *                              - hindex : Incremented (+1) parameter value.
		 *                              - callback : undefined.
		 */
		loadFragmentRecursive: function (context, transaction, fragments, hindex, reload, callback) {
			/* We need to check the delta to compute the parts to load/unload by comparing : the fragment of context at a specific position of the
			 * hierarchy and the URL fragment at the same position.
			 * There is a difference when :
			 * - fragment is defined and different from the defined one of compared context
			 * - fragment is not defined, but the defined one of compared context does not correspond to the home context of the parent
			 */
			var hierarchy = $self.getContextHierarchy(context);
			var parent = hierarchy[hindex - 1];
			var sharedContext = hierarchy[hindex];
			if (sharedContext) {
				if (sharedContext.$fragment && sharedContext.$fragment !== fragments[hindex] &&
					((typeof fragments[hindex] !== 'undefined') || sharedContext.$fragment !== (sharedContext.$parent.$home || 'home'))) {
					// Different context root, recursively unload all related contextes and move context its parent
					context = $self.unload(sharedContext);
				} else {
					// Same context, no fragment to load at this point, continue to the next hoerarchy index
					if (fragments.length <= hindex) {
						// Add fragment from the validated and yet not explicitly
						fragments.push(sharedContext.$fragment);
					}
					$self.loadFragmentRecursive(context, transaction, fragments, hindex + 1, reload);
					return;
				}
			}

			// Build the remaining fragments and considered as parameters
			var parameters = fragments.slice(hindex).join('/');

			// Check the cursor
			if (hindex >= fragments.length) {
				// Load is completed but we have to check the implicit fragments such as "home"
				if ($self.finalize(parent, parameters, transaction)) {
					// There is no more implicit fragments to add, and there is no parameter
					return;
				}
				// This module contains a landing page. It is added to the explicit fragments, and the recursive process continues
				fragments.push(parent.$home || 'home');
			} else if ($self.finalize(parent, parameters, transaction)) {
				// All remaining fragments have been consumed as parameters
				return;
			}

			// At least one fragment need to be loaded
			var id = fragments[hindex];
			$self.loadFragment(parent, transaction, ((parent.$path || '') + '/').replace(/^\//, '') + id, id, {
				loadHtml: true,
				loadI18n: true,
				loadController: true,
				loadCss: true,
				fragment: id,
				reload: reload,
				hindex: hindex,
				parameters: fragments.slice(hindex + 1).join('/'),
				callback: callback || function (childContext) {
					$self.loadFragmentRecursive(context.$child || childContext, transaction, fragments, hindex + 1, reload);
				}
			});
		},

		/**
		 * Load CSS, i18n, template and controller from the provided data. Extended i18n messages will also be
		 * merged into the parent and in the closest page in addition. So, unloading this module will not
		 * remove these extension. This is a complete merge of i18n properties. The template, CSS and
		 * controller will be inserted into a private zone, and will be removed whith the parent on its unload.
		 * @param {object} context  The parent context to use.
		 * @param {String} home     The home URL of module to load. CSS, HTML, i18n and controller will be loaded from this base.
		 * @param {String} id       The module identifier. Used to determine the base file name inside the home URL.
		 * @param {object} options  Optional options :
		 *                            - {function} callback      Callback when all modules are loaded, controller is initialized.
		 *                            - {function} viewBuilder   Builder function replacing the default view built from template and messages.
		 *                                                       When defined, the function will be called with the newly created context with
		 *                                                       "$template" already injected in the created context.
		 *                                                       The return will be placed in the parent view and injected into the context as
		 *                                                       $view.
		 *                            - {jQuery} $parentElement  Parent jQUery that will dirrectly contains the view and would become the new
		 *                                                       view of this load.
		 *                                                       When undefined, the created view will be inside the previous container's view
		 *                                                       inside a wrapper with an unique identifier based on home and the formal
		 *                                                       parameter "id". In this case, the parent view may contains several siblings
		 *                                                       having the view as container.
		 *                            - {boolean} reload         When "true" the previous identical view is removed, along the CSS and controller
		 *                                                       before this new load.
		 *                                                       The match is based on the built identifier placed in the view.
		 *                            - {string} fragment        Related url fragment part associated to this context.
		 *                            - {boolean} loadCss        When "true" the CSS file will be loaded and placed in the head of the document.
		 *                            - {boolean} loadI18n       When "true" the internationalization files will be loaded and merged withe the
		 *                                                       messages from the parent hierarchy of context using LIFO priority for
		 *                                                       resolution.
		 *                            - {boolean} loadHtml       When "true" the HTML file will be loaded and compiled with Handlebars and i18n
		 *                                                       messages if loaded.
		 *                            - {boolean} loadController When "true" the JS file will be loaded and "initialize" function if defined will
		 *                                                       be called. When this function is called, view is already placed in the document,
		 *                                                       css is loaded, and "$current" context fully built with all componentes injected.
		 *                                                       This function wil also receive the non consumed URL fragments array that could
		 *                                                       be considered as parameters.
		 *                            - {integer} hindex         When defined (>=0) without "$parentElement", will be used to resolve the parent
		 *                                                       element and will be used as "$parentElement".
		 *                                                       May also be usefull for CSS selectors to change the display of component
		 *                                                       depending the placement inside the hierarchy.
		 *                                                       The CSS selector (where X corresponds to hdindex) used to resolve this parent
		 *                                                       will be: #_hierachy-X,[data-loader-hierachy=X],.data-loader-hierachy-X
		 *                            - {object} data            Data to save in the new context inside "$data".
		 *                            - {string} parameters      Parameters as string to pass to the controler during the initialization.
		 */
		loadFragment: function (context, transaction, home, id, options) {
			home = home.replace(/\/$/, '');
			var base = home + '/' + id;

			// Load with AMD the resources
			var requireMessages = 'i18n!' + home + '/nls/messages';
			var requireHtml = 'text!' + base + '.html';
			var requireCss = 'css!' + base + '.css';
			var requireController = base;
			require([
				options.loadHtml ? requireHtml : 'ready!', // Template part
				options.loadI18n ? requireMessages : 'ready!', // Messages part
				options.loadController ? requireController : 'ready!', // Controller part
				options.loadCss ? requireCss : 'ready!' // CSS part, injected in HEAD. Not manually managed.
			], function (template, messages, $current) {
				// Check the context after this AMD call
				if (!$self.isSameTransaction(transaction)) {
					return;
				}

				// Find the right UI parent
				var $parentElement = options.$parentElement;
				var createdSibling = false;
				var siblingMode = false;
				if (((typeof $parentElement) !== 'object' || $parentElement.length === 0) && options.hindex >= 0) {
					$parentElement = $self.findNextContainer(context, options.hindex);
				}

				// Clean the resolution and reject empty parent
				if ((typeof $parentElement) !== 'object' || $parentElement.length === 0) {
					// No valid parent found, we will add the new UI inside the context's view as a wrapped child node
					var viewId = '_module-' + base;
					siblingMode = true;
					$parentElement = _(viewId);
					if ($parentElement.length === 0) {
						// Create the wrapper
						createdSibling = true;
						$parentElement = $('<div id="' + viewId + '"></div>');
						context.$view.append($parentElement);
					}
				}

				// Clean the previous state
				if (options.reload) {
					// Invalidate the previous view
					$parentElement.empty();
				} else if (siblingMode && !createdSibling) {
					// Call only the callback, nothing has been unloaded or created
					options.callback && options.callback($current);
					return;
				}

				// Build the trimmed URL by removing the root path (main)
				var url = home.split('/');
				url.shift();

				// Configure the new context
				$current = $self.failSafeContext($current || {}, context, transaction);
				$current.$view = $parentElement;
				$current.$path = home;
				$current.$url = '#/' + url.join('/');
				$current.$data = options.data;
				$current.$hindex = options.hindex;
				$current.$fragment = options.fragment;
				$current.$parameters = options.parameters;
				$current.$template = template && Handlebars.compile(template);
				$current.$require = {
					messages: requireMessages,
					view: requireHtml,
					css: requireCss,
					controller: requireController
				};

				// Complete the hierarchy
				if (siblingMode) {
					// Include without adding an element in the hierarchy, title is unchanged
					$current.$page = context.$page || context;
					context.$siblings.push($current);
				} else {
					// Share this context
					$self.$current = $current;
					context.$child = $current;
				}

				// Build the messages with inheritance
				$self.buildMessages($current, messages || {});

				if (!siblingMode && $current.$messages.title) {
					// Title has been redefined at this level
					document.title = $current.$messages.title;
				}

				// Insert the compiled view in the wrapper
				$current.$view.off().empty().html((options.viewBuilder || $self.viewBuilder)($current));
				$self.trigger('fragment-' + id, context, context);

				// Initialize the controller
				$self.initializeContext($current, transaction, options.callback, options.parameters);
			});
		},

		/**
		 * Load partials from a markup definition, inject the compiled template HTML inside the current element with loaded i18n file, load the CSS and initialize the controller.
		 * 'data-ajax' attribute defines the identifier of resources to load. Is used to build the base name of html, js,... and also used as an idenfier built withe the identifier of containing view.
		 * 'data-ajax-load' attribute defines the resources to be loaded. By default the HTML template is loaded and injected inside the current element.
		 */
		loadPartial: function (context) {
			var $target;
			if ((typeof context.$fragments) === 'undefined') {
				context = $self.$current;
				$target = $(this);
			} else {
				$target = context.$view;
			}

			// Get the resource to load : HTML, CSS, JS, i28N ? By default the HTML is loaded
			var load = ($target.attr('data-ajax-load') || 'html').split(',');
			$self.loadFragment(context, context.transaction, context.$path, $target.attr('data-ajax'), {
				$parentElement: $target,
				loadCss: $.inArray('css', load) >= 0,
				loadHtml: $.inArray('html', load) >= 0,
				loadI18n: $.inArray('i18n', load) >= 0,
				loadController: $.inArray('js', load) >= 0
			});
		},

		/**
		 * Check the transaction corresponds to the given one.
		 * @param transaction : Object or number
		 */
		isSameTransaction: function (transaction, context) {
			return (transaction.$transaction === $self.transaction || transaction === $self.transaction) &&
				(typeof (context || transaction).$unloaded === 'undefined');
		},

		/**
		 * Start a new navigation transaction and returns its identifier.
		 */
		newTransaction: function () {
			return ++$self.transaction;
		},

		failSafeContext: function (context, parent, transaction) {
			if (typeof context === 'function') {
				// Function generating the current object
				context = context($self);
			}
			context = context || {};

			// Propagate the hierarchy
			context.$parent = parent;
			context.$siblings = [];
			if (parent) {
				if (parent.$hindex === 0) {
					// Set the top most real module as '$main'
					context.$main = context;
				} else {
					context.$main = parent.$main;
				}
			}

			context.$session = $self.session;

			// Propagate the transaction
			$self.propagateTransaction(context, transaction);
			return context;
		},

		/**
		 * Prapagate the transaction from current context to parent context.
		 * @param context : Context to update.
		 * @param transaction : Transaction identifier to propage to the hierarchy.
		 */
		propagateTransaction: function (context, transaction) {
			context.$parent && $self.propagateTransaction(context.$parent, transaction);
			context.$transaction = transaction;
		},

		/**
		 * Initialize the given context by calling the optional 'initialize' function if provided, and with
		 * given parameters.
		 */
		initializeContext: function (context, transaction, callback, parameters) {
			// Initialize the module if managed
			if ((typeof context !== 'undefined') && (typeof context.initialize === 'function')) {
				$(function () {
					if (!$self.isSameTransaction(transaction)) {
						return;
					}
					$.proxy(context.initialize, context)(parameters);

					// Mark the context as initialized
					context.$initializeTransaction = transaction;
					callback && callback(context);
				});
			} else if (callback) {
				callback(context);
			}
		},

		/**
		 * Add a spin. Return the target element.
		 * @param $to Target container.
		 * @param sizeClass Optional Fontawesome size icon class such as : 'fa-3x'
		 * @param iconClass Optional icon class. If not defined, will be 'fa fa-spin fa-circle-o-notch'
		 * @return "$to" parameter.
		 */
		appendSpin: function ($to, sizeClass, iconClass) {
			var $spin = $('<i class="' + (iconClass || 'fa fa-circle-o faa-burst animated') + ' spin fade ' + (sizeClass || '') + '"></i>');
			$to.append($spin);
			setTimeout(function () {
				$spin.addClass('in');
			}, 1500);
			setTimeout(function () {
				$spin.addClass('text-warning');
			}, 3000);
			setTimeout(function () {
				$spin.removeClass('text-warning').addClass('text-danger');
			}, 10000);
			return $to;
		},

		/**
		 * Remove the spin from the node. Only direct spins are removed.
		 * @param $from Container to clean.
		 * @return '$from' parameter.
		 */
		removeSpin: function ($from) {
			$from.children('.spin').remove();
			return $from;
		},

		/**
		 * Initialize the application
		 */
		initialize: function () {
			this.isOldIE = $('html.ie-old').length;
			$.ajaxSetup({
				cache: false
			});

			$.fn.htmlNoStub = $.fn.html;
			if (!$self.manualDomReady) {
				// Stub the html update to complete DOM with post-actions
				var originalHtmlMethod = $.fn.html;
				$.fn.extend({
					html: function () {
						if (!$self.manualDomReady && arguments.length === 1) {
							// proceed only for identified parent to manage correctly the selector
							var id = this.attr('id');
							if (id && id.substr(0, 2) !== 'jq') {
								applicationManager.debug && traceDebug('Html content updated for ' + id);
								var result = originalHtmlMethod.apply(this, arguments);
								$self.trigger('html', this);
								return result;
							}
						}
						return originalHtmlMethod.apply(this, arguments);
					}
				});
			}

			// We can register the fragment listener now
			$(function () {
				var handleHash = function () {
					var hash = location.hash;
					if (hash && hash.indexOf('#/') === 0) {
						$self.load(hash.substr(2));
					} else if (hash === '') {
						$self.load('');
					}
				};
				$(window).hashchange(function () {
					handleHash();
				});
				handleHash();
			});
		},

		isFinal: function (context) {
			return context.$final || $self.findNextContainer(context).length === 0;
		},

		/**
		 * Return the nested hierarical container inside the view of current context. The used CSS selector (where X corresponds to hdindex) used to resolve this parent will be:
		 * #_hierachy-X,[data-loader-hierachy=X],.data-loader-hierachy-X
		 * @param  {object} context The context to complete.
		 * @param  {integer} hindex Optional hierarchical index to lookup. When undefined, will use the one of provided context plus one.
		 * @return {jquery}         A jQuery object of the found element. Only the first match is returned.
		 */
		findNextContainer: function (context, hindex) {
			hindex = hindex || context.$hindex + 1;
			return context.$view.find('#_hierachy-' + hindex + ',[data-loader-hierachy="' + hindex + '"],.data-loader-hierachy-' + hindex).first();
		},

		finalize: function (context, parameters, transaction) {
			if ($self.isFinal(context)) {
				// There is no more implicit fragment to add, the context hierarchy is loaded
				// Commit the transaction
				$self.propagateTransaction(context, transaction);

				// Check the parameters change
				if ((context.$parameters || '') !== (parameters || '')) {
					// Save the new parameters and trigger the change event
					context.$parameters = parameters;
					if ((typeof context.onHashChange) === 'function' && context.$initializeTransaction && context.$initializeTransaction !== transaction) {
						// Parameters are managed by the current module
						$.proxy(context.onHashChange, context)(parameters);
					}
					$self.trigger('hash', context.$url + (parameters ? '/' + parameters : ''), context);
				}
				return true;
			}
			return false;
		},

		register: function (event, listener) {
			$self.callbacks[event] = $self.callbacks[event] || [];
			$self.callbacks[event].push(listener);
		},

		/**
		 * Proceed all registered post DOM ready functions.
		 * @param {string} event    The event name to trigger.
		 * @param {object} data 	Optional data to attach to this event. Will the the current view as default.
		 * @param {object} context 	Optional context to attach to the event.
		 * @return selector
		 */
		trigger: function (event, data, context) {
			applicationManager.debug && traceDebug('Trigger event', event);
			var callbacks = $self.callbacks[event] || [];
			for (var i = 0; i < callbacks.length; i++) {
				if (typeof callbacks[i] === 'function') {
					callbacks[i](data || (context || $self.$context).$view, context);
				} else {
					traceLog('Expected function, but got "' + typeof callbacks[i] + '" : ' + callbacks[i]);
				}
			}
			return data;
		}
	};
	return $self;
});
