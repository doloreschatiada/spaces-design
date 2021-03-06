/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        Immutable = require("immutable"),
        _ = require("lodash");

    var descriptor = require("adapter").ps.descriptor,
        layerLib = require("adapter").lib.layer,
        pathLib = require("adapter").lib.path,
        documentLib = require("adapter").lib.document,
        contentLayerLib = require("adapter").lib.contentLayer;

    var events = require("../events"),
        locks = require("js/locks"),
        layerActions = require("./layers"),
        collection = require("js/util/collection"),
        layerActionsUtil = require("js/util/layeractions"),
        nls = require("js/util/nls");

    /**
     * Merges shape specific options into given options
     * play/batchPlay options that allow the canvas to be continually updated, 
     * and history state to be consolidated 
     *
     * @private
     * @param {object} options
     * @param {Document} document Owner document
     * @param {string} name localized name to put into the history state
     * @return {object} options
     */
    var _mergeOptions = function (options, document, name) {
        options = options || {
            coalesce: false
        };

        return _.merge({}, options, {
            paintOptions: {
                immediateUpdate: true,
                quality: "draft"
            },
            historyStateInfo: {
                name: name,
                target: documentLib.referenceBy.id(document.id),
                coalesce: !!options.coalesce,
                suppressHistoryStateNotification: !!options.coalesce
            },
            isUserInteractionCommand: !!options.coalesce
        });
    };

    /**
     * Helper function to generically dispatch strokes update events
     *
     * @private
     * @param {Document} document active Document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {object} strokeProperties a pseudo stroke object containing only new props
     * @param {string} eventName name of the event to emit afterwards
     * @param {boolean=} coalesce optionally include this in the payload to drive history coalescing
     * @return {Promise}
     */
    var _strokeChangeDispatch = function (document, layers, strokeProperties, eventName, coalesce) {
        var payload = {
            documentID: document.id,
            layerIDs: collection.pluck(layers, "id"),
            strokeProperties: strokeProperties,
            coalesce: coalesce,
            history: {
                newState: true
            }
        };

        return this.dispatchAsync(eventName, payload);
    };

    /**
     * Helper function to generically dispatch fills update events
     *
     * @private
     * @param {Document} document active Document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {object} fillProperties a pseudo fill object containing only new props
     * @param {string} eventName name of the event to emit afterwards
     * @param {boolean=} coalesce optionally include this in the payload to drive history coalescing
     * @return {Promise}
     */
    var _fillChangeDispatch = function (document, layers, fillProperties, eventName, coalesce) {
        // TODO layers param needs to be made fa real
        var payload = {
            documentID: document.id,
            layerIDs: collection.pluck(layers, "id"),
            fillProperties: fillProperties,
            coalesce: coalesce,
            history: {
                newState: true
            }
        };

        return this.dispatchAsync(eventName, payload);
    };

    /**
     * Test the given layers for the existence of a stroke
     *
     * @private
     * @param {Immutable.Iterable.<Layer>} layers set of layers to test
     *
     * @return {boolean} true if all strokes exist
     */
    var _allStrokesExist = function (layers) {
        return layers.every(function (layer) {
            return layer.stroke;
        });
    };

    /**
     * Make a batch call to photoshop to get the Stroke Style information for the specified layers
     * Use the results to build a payload of strokes to add at the specified index
     *
     * @private
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     *
     * @return {Promise} Promise of the initial batch call to photoshop
     */
    var _refreshStrokes = function (document, layers) {
        var layerIDs = collection.pluck(layers, "id"),
            refs = layerLib.referenceBy.id(layerIDs.toArray());

        return descriptor.batchMultiGetProperties(refs._ref, ["AGMStrokeStyleInfo"])
            .bind(this)
            .then(function (batchGetResponse) {
                if (!batchGetResponse || batchGetResponse.length !== layers.size) {
                    throw new Error("Bad response from photoshop for AGMStrokeStyleInfo batchGet");
                }
                var payload = {
                    documentID: document.id,
                    layerIDs: layerIDs,
                    strokeStyleDescriptor: Immutable.List(_.pluck(batchGetResponse, "AGMStrokeStyleInfo")),
                    history: {
                        newState: true,
                        amendRogue: true
                    }
                };
                this.dispatch(events.document.history.STROKE_ADDED, payload);
            });
    };

    /**
     * Sets the stroke properties of given layers identical to the given stroke
     * 
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {Stroke} stroke Stroke properties to apply
     * @param {object} options
     * @param {boolean=} options.enabled Default true
     * @return {Promise}
     */
    var setStroke = function (document, layers, stroke, options) {
        // if enabled is not provided, assume it is true
        // derive the type of event to be dispatched based on this parameter's existence
        options = _.merge({}, options); // create a copy of the options
        
        var eventName;

        if (options.enabled === undefined || options.enabled === null) {
            options.enabled = true;
            eventName = events.document.history.STROKE_CHANGED;
        } else {
            eventName = events.document.history.STROKE_ENABLED_CHANGED;
        }

        var layerRef = contentLayerLib.referenceBy.current,
            strokeObj = contentLayerLib.setStroke(layerRef, stroke),
            strokeJSObj = stroke.toJS();

        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_STROKE"));

        // toJS gets rid of color so we re-insert it here
        strokeJSObj.color = stroke.color.normalizeAlpha();
        strokeJSObj.opacity = strokeJSObj.color.a;

        // optimistically dispatch the change event    
        var dispatchPromise = _strokeChangeDispatch.call(this,
            document,
            layers,
            strokeJSObj,
            eventName);

        var strokePromise = layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options);

        return Promise.join(dispatchPromise, strokePromise,
            function () {
                return this.transfer(layerActions.resetBounds, document, layers);
            }.bind(this));
    };
    setStroke.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetBounds"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Set the color of the stroke for the given layers of the given document
     * If there are selected layers that do not currently have a stroke, then a subsequent call
     * will be made to fetch the stroke style for each layer, and the result will be used to update the stroke store.
     * This is necessary because photoshop does not report the width in the first response
     * 
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {?Color} color
     * @param {object} options
     * @param {boolean=} options.enabled optional enabled flag, default=true.
     *                                  If supplied, causes a resetBounds afterwards
     * @param {boolean=} options.coalesce Whether to coalesce this operation's history state
     * @param {boolean=} options.ignoreAlpha Whether to ignore the alpha value of the
     *  supplied color and only update the opaque color.
     * @return {Promise}
     */
    var setStrokeColor = function (document, layers, color, options) {
        // if a color is provided, adjust the alpha to one that can be represented as a fraction of 255
        color = color ? color.normalizeAlpha() : null;
        options = _.merge({}, options); // make a copy of the options

        // if enabled is not provided, assume it is true
        // derive the type of event to be dispatched based on this parameter's existence
        var eventName,
            enabledChanging;
        if (options.enabled === undefined || options.enabled === null) {
            options.enabled = true;
            eventName = events.document.history.STROKE_COLOR_CHANGED;
        } else {
            eventName = events.document.history.STROKE_ENABLED_CHANGED;
            enabledChanging = true;
        }

        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_STROKE_COLOR"));

        var colorPromise,
            psColor,
            strokeObj,
            layerRef = contentLayerLib.referenceBy.current;

        if (_allStrokesExist(layers)) {
            // optimistically dispatch the change event    
            var dispatchPromise = _strokeChangeDispatch.call(this,
                document,
                layers,
                { enabled: options.enabled, color: color, ignoreAlpha: options.ignoreAlpha },
                eventName,
                options.coalesce);

            if (!color && options.enabled) {
                // If color is not supplied, we use existing color from our model
                var actions = layers.map(function (layer) {
                    psColor = layer.stroke.color.toJS();

                    if (options.ignoreAlpha) {
                        delete psColor.a;
                    }

                    var layerRef = contentLayerLib.referenceBy.id(layer.id),
                        setStrokeObj = contentLayerLib.setStrokeFillTypeSolidColor(layerRef, psColor);

                    return {
                        layer: layer,
                        playObject: setStrokeObj
                    };
                }, this);

                colorPromise = layerActionsUtil.playLayerActions(document, actions, true, options);
            } else {
                // remove the alpha component based on ignoreAlpha param
                psColor = color ? color.toJS() : null;
                if (psColor && options.ignoreAlpha) {
                    delete psColor.a;
                }
                
                strokeObj = contentLayerLib.setStrokeFillTypeSolidColor(layerRef, options.enabled ? psColor : null);
                colorPromise = layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options);
            }
            
            // after both, if enabled has potentially changed, transfer to resetBounds
            return Promise.join(dispatchPromise,
                colorPromise,
                function () {
                    if (enabledChanging) {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }
                }.bind(this));
        } else {
            // remove the alpha component based on ignoreAlpha param
            psColor = color ? color.toJS() : null;
            
            if (psColor && options.ignoreAlpha) {
                delete psColor.a;
            }

            strokeObj = contentLayerLib.setStrokeFillTypeSolidColor(layerRef, options.enabled ? psColor : null);
            
            return layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options)
                .bind(this)
                .then(function () {
                    // upon completion, fetch the stroke info for all layers
                    _refreshStrokes.call(this, document, layers);
                });
        }
    };
    setStrokeColor.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetBounds"]
    };

    /**
     * Sets the enabled flag for all selected Layers on a given doc.
     *
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {object} options
     * @param {boolean=} options.enabled
     * @return {Promise}
     */
    var setStrokeEnabled = function (document, layers, options) {
        return this.transfer(setStrokeColor, document, layers, null, options);
    };
    setStrokeEnabled.action = {
        reads: [],
        writes: [],
        transfers: [setStrokeColor],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Set the alignment of the stroke for all selected layers of the given document.
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {string} alignmentType type as inside,outside, or center
     * @param {object} options
     * @return {Promise}
     */
    var setStrokeAlignment = function (document, layers, alignmentType, options) {
        var layerRef = contentLayerLib.referenceBy.current,
            strokeObj = contentLayerLib.setStrokeAlignment(layerRef, alignmentType);

        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_STROKE_ALIGNMENT"));

        if (_allStrokesExist(layers)) {
            // optimistically dispatch the change event    
            var dispatchPromise = _strokeChangeDispatch.call(this,
                    document,
                    layers,
                    { alignment: alignmentType, enabled: true },
                    events.document.history.STROKE_ALIGNMENT_CHANGED);

            var alignmentPromise = layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options);

            return Promise.join(dispatchPromise,
                alignmentPromise,
                    function () {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }.bind(this));
        } else {
            return layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options)
                .bind(this)
                .then(function () {
                    // upon completion, fetch the stroke info for all layers
                    _refreshStrokes.call(this, document, layers);
                });
        }
    };
    setStrokeAlignment.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetBounds"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Set the opacity of the stroke for all selected layers of the given document.
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {number} opacity opacity as a percentage [0,100]
     * @param {object} options
     * @param {boolean=} options.coalesce Whether to coalesce this operation's history state
     * @return {Promise}
     */
    var setStrokeOpacity = function (document, layers, opacity, options) {
        var layerRef = contentLayerLib.referenceBy.current,
            strokeObj = contentLayerLib.setStrokeOpacity(layerRef, opacity);

        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_STROKE_OPACITY"));

        if (_allStrokesExist(layers)) {
            // optimistically dispatch the change event    
            var dispatchPromise = _strokeChangeDispatch.call(this,
                document,
                layers,
                { opacity: opacity, enabled: true },
                events.document.history.STROKE_OPACITY_CHANGED,
                options.coalesce);

            var opacityPromise = layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options);

            return Promise.join(dispatchPromise, opacityPromise);
        } else {
            // There is an existing photoshop bug that clobbers color when setting opacity
            // on a set of layers that inclues "no stroke" layers.  SO this works as well as it can
            return layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options)
                .bind(this)
                .then(function () {
                    // upon completion, fetch the stroke info for all layers
                    _refreshStrokes.call(this, document, layers);
                });
        }
    };
    setStrokeOpacity.action = {
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Set the size of the stroke for all selected layers of the given document
     * 
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {number} width stroke width, in pixels
     * @param {object} options
     * @return {Promise}
     */
    var setStrokeWidth = function (document, layers, width, options) {
        var layerRef = contentLayerLib.referenceBy.current,
            strokeObj = contentLayerLib.setShapeStrokeWidth(layerRef, width);

        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_STROKE_WIDTH"));

        if (_allStrokesExist(layers)) {
            // dispatch the change event    
            var dispatchPromise = _strokeChangeDispatch.call(this,
                document,
                layers,
                { width: width, enabled: true },
                events.document.history.STROKE_WIDTH_CHANGED);

            var widthPromise = layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options);

            return Promise.join(dispatchPromise,
                    widthPromise,
                    function () {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }.bind(this));
        } else {
            return layerActionsUtil.playSimpleLayerActions(document, layers, strokeObj, true, options)
                .bind(this)
                .then(function () {
                    // upon completion, fetch the stroke info for all layers
                    _refreshStrokes.call(this, document, layers);
                });
        }
    };
    setStrokeWidth.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetBounds"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Set the enabled flag for the given fill of all selected Layers on a given doc
     * 
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {object} options
     * @param {boolean=} options.enabled
     * @return {Promise}
     */
    var setFillEnabled = function (document, layers, options) {
        options = _.merge({}, options, {
            coalesce: false,
            ignoreAlpha: false
        });

        return setFillColor.call(this, document, layers, null, options);
    };
    setFillEnabled.action = {
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Set the color of the fill for all selected layers of the given document
     * 
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers list of layers being updating
     * @param {Color} color
     * @param {object} options
     * @param {boolean=} options.coalesce Whether to coalesce this operation's history state
     * @return {Promise}
     */
    var setFillColor = function (document, layers, color, options) {
        // if a color is provided, adjust the alpha to one that can be represented as a fraction of 255
        color = color ? color.normalizeAlpha() : null;
        // if enabled is not provided, assume it is true
        options = _.merge({}, options);
        options.enabled = (options.enabled === undefined) ? true : options.enabled;

        // dispatch the change event    
        var dispatchPromise = _fillChangeDispatch.call(this,
                document,
                layers,
                { color: color, enabled: options.enabled, ignoreAlpha: options.ignoreAlpha },
                events.document.history.FILL_COLOR_CHANGED,
                options.coalesce),
            colorPromise;

        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_FILL_COLOR"));

        if (!color && options.enabled) {
            // If color is not supplied, we want each layer to use it's own color
            var actions = layers.map(function (layer) {
                var layerRef = contentLayerLib.referenceBy.id(layer.id),
                    setFillObj = contentLayerLib.setShapeFillTypeSolidColor(layerRef, layer.fill.color);

                return {
                    layer: layer,
                    playObject: setFillObj
                };
            }, this);

            colorPromise = layerActionsUtil.playLayerActions(document, actions, true, options);
        } else {
            // build the playObject
            var contentLayerRef = contentLayerLib.referenceBy.current,
                layerRef = layerLib.referenceBy.current,
                fillColor = options.enabled ? color : null,
                fillColorObj = contentLayerLib.setShapeFillTypeSolidColor(contentLayerRef, fillColor);
                
            // submit to Ps
            if (options.enabled && !options.ignoreAlpha) {
                var fillOpacityObj = layerLib.setFillOpacity(layerRef, color.opacity);
                colorPromise = layerActionsUtil.playSimpleLayerActions(document, layers, [fillColorObj, fillOpacityObj],
                    true, options);
            } else {
                colorPromise = layerActionsUtil.playSimpleLayerActions(document, layers, fillColorObj, true, options);
            }
        }

        return Promise.join(dispatchPromise, colorPromise);
    };
    setFillColor.action = {
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC],
        modal: true
    };

    /**
     * Set the opacity of the fill for all selected layers of the given document
     * If only changing the alpha, this has a slight savings over setFillColorCommand by only using one adapter call
     * 
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers
     * @param {number} opacity Opacity percentage [0,100]
     * @param {object} options
     * @param {boolean=} options.coalesce Whether to coalesce this operation's history state
     * @return {Promise}
     */
    var setFillOpacity = function (document, layers, opacity, options) {
        options = _mergeOptions(options, document, nls.localize("strings.ACTIONS.SET_FILL_OPACITY"));
            
        var dispatchPromise = _fillChangeDispatch.call(this,
                document,
                layers,
                { opacity: opacity, enabled: true },
                events.document.history.FILL_OPACITY_CHANGED,
                !!options.coalesce),
            layerRef = layerLib.referenceBy.current,
            fillObj = layerLib.setFillOpacity(layerRef, opacity),
            opacityPromise = layerActionsUtil.playSimpleLayerActions(document, layers, fillObj, true, options);

        return Promise.join(dispatchPromise, opacityPromise);
    };
    setFillOpacity.action = {
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Call the adapter and then transfer to another action to reset layers as necessary
     *
     * If multiple layers are being combined, then the first layer is replaced by fresh 
     * data from photoshop (fetched via index), and the subsumed layers are deleted from the model
     *
     * If there is only one layer, it is simply reset afterwards
     *
     * @private
     * @param {Document} document
     * @param {Immutable.List.<Layer>} layers 
     * @param {PlayObject} playObject
     * @return {Promise}
     */
    var _playCombine = function (document, layers, playObject) {
        if (layers.isEmpty()) {
            return Promise.resolve();
        }

        var dispatchPromise,
            payload = {
                documentID: document.id,
                history: {
                    newState: true,
                    name: nls.localize("strings.ACTIONS.COMBINE_SHAPES")
                }
            };

        if (layers.size > 1) {
            payload.layerIDs = collection.pluck(layers.butLast(), "id");
            dispatchPromise = this.dispatchAsync(events.document.history.DELETE_LAYERS, payload);
        } else {
            dispatchPromise = this.dispatchAsync(events.history.NEW_HISTORY_STATE, payload);
        }

        var options = {
                historyStateInfo: {
                    name: nls.localize("strings.ACTIONS.COMBINE_SHAPES"),
                    target: documentLib.referenceBy.id(document.id)
                }
            },
            playPromise = descriptor.playObject(playObject, options);

        return Promise.join(dispatchPromise, playPromise)
            .bind(this)
            .then(function () {
                if (layers.size > 1) {
                    // The "highest" layer wins but the resultant layer is shifted down 
                    // by the number of "losing" layers
                    // Important note: the resultant layer has a NEW LAYER ID
                    var winningLayerIndex = document.layers.indexOf(layers.last()),
                        adjustedLayerIndex = winningLayerIndex - layers.size + 1;

                    return this.transfer(layerActions.resetLayersByIndex, document, adjustedLayerIndex);
                } else {
                    return this.transfer(layerActions.resetLayers, document, layers);
                }
            });
    };

    /**
     * Combine paths using UNION operation
     *
     * @param {?Document=} document Default is current document
     * @param {?Immutable.List.<Layer>} layers Default is selected layers
     * @return {Promise}
     */
    var combineUnion = function (document, layers) {
        var appStore = this.flux.store("application");

        document = document || appStore.getCurrentDocument();
        layers = layers || document ? document.layers.selected : null;

        if (!document || !layers || layers.isEmpty()) {
            return Promise.resolve();
        } else if (layers.size === 1) {
            return _playCombine.call(this, document, layers, pathLib.combinePathsUnion());
        } else {
            if (!document.layers.selectedLayersContainOnlyShapeLayers) {
                return Promise.resolve();
            } else {
                return _playCombine.call(this, document, layers, pathLib.combineLayersUnion());
            }
        }
    };
    combineUnion.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetLayers", "layers.resetLayersByIndex"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Combine paths using SUBTRACT operation
     *
     * @param {?Document} document Default is current document
     * @param {?Immutable.List.<Layer>} layers Default is selected layers
     * @return {Promise}
     */
    var combineSubtract = function (document, layers) {
        var appStore = this.flux.store("application");

        document = document || appStore.getCurrentDocument();
        layers = layers || document ? document.layers.selected : null;

        if (!document || !layers || layers.isEmpty()) {
            return Promise.resolve();
        } else if (layers.size === 1) {
            return _playCombine.call(this, document, layers, pathLib.combinePathsSubtract());
        } else {
            if (!document.layers.selectedLayersContainOnlyShapeLayers) {
                return Promise.resolve();
            } else {
                return _playCombine.call(this, document, layers, pathLib.combineLayersSubtract());
            }
        }
    };
    combineSubtract.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetLayers", "layers.resetLayersByIndex"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Combine paths using INTERSECT operation
     *
     * @param {?Document} document Default is current document
     * @param {?Immutable.List.<Layer>} layers Default is selected layers
     * @return {Promise}
     */
    var combineIntersect = function (document, layers) {
        var appStore = this.flux.store("application");

        document = document || appStore.getCurrentDocument();
        layers = layers || document ? document.layers.selected : null;

        if (!document || !layers || layers.isEmpty()) {
            return Promise.resolve();
        } else if (layers.size === 1) {
            return _playCombine.call(this, document, layers, pathLib.combinePathsIntersect());
        } else {
            if (!document.layers.selectedLayersContainOnlyShapeLayers) {
                return Promise.resolve();
            } else {
                return _playCombine.call(this, document, layers, pathLib.combineLayersIntersect());
            }
        }
    };
    combineIntersect.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetLayers", "layers.resetLayersByIndex"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    /**
     * Combine paths using DIFFERENCE operation
     *
     * @param {?Document} document Default is current document
     * @param {?Immutable.List.<Layer>} layers Default is selected layers
     * @return {Promise}
     */
    var combineDifference = function (document, layers) {
        var appStore = this.flux.store("application");

        document = document || appStore.getCurrentDocument();
        layers = layers || document ? document.layers.selected : null;

        if (!document || !layers || layers.isEmpty()) {
            return Promise.resolve();
        } else if (layers.size === 1) {
            return _playCombine.call(this, document, layers, pathLib.combinePathsDifference());
        } else {
            if (!document.layers.selectedLayersContainOnlyShapeLayers) {
                return Promise.resolve();
            } else {
                return _playCombine.call(this, document, layers, pathLib.combineLayersDifference());
            }
        }
    };
    combineDifference.action = {
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC],
        transfers: ["layers.resetLayers", "layers.resetLayersByIndex"],
        post: ["verify.layers.verifySelectedBounds"]
    };

    exports.setStrokeEnabled = setStrokeEnabled;
    exports.setStrokeWidth = setStrokeWidth;
    exports.setStrokeColor = setStrokeColor;
    exports.setStrokeOpacity = setStrokeOpacity;
    exports.setStrokeAlignment = setStrokeAlignment;
    exports.setStroke = setStroke;

    exports.setFillEnabled = setFillEnabled;
    exports.setFillColor = setFillColor;
    exports.setFillOpacity = setFillOpacity;

    exports.combineUnion = combineUnion;
    exports.combineSubtract = combineSubtract;
    exports.combineIntersect = combineIntersect;
    exports.combineDifference = combineDifference;
});
