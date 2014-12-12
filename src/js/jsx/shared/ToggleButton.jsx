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
 
define(function (require, exports, module) {
    "use strict";

    var React = require("react");

    var ToggleButton = React.createClass({
        mixins: [React.addons.PureRenderMixin],

        getInitialState: function () {
            return {
                selected: this.props.selected || false
            };
        },

        render: function () {
            var size = this.props.size || "column-1",
                buttonType = this.props.buttonType || "default",
                myClass = ["button-toggle", size, (this.props.className || "")].join(" ");

            return (
                <div
                    title={this.props.title}
                    data-type={buttonType}
                    data-selected={this.state.selected}
                    className={myClass}
                    onClick={this.handleClick}
                    />
            );
        },

        componentWillReceiveProps: function (nextProps) {
            if (nextProps.hasOwnProperty("selected")) {
                this.setState({ selected: nextProps.selected });
            }
        },

        handleClick: function (event) {
            var newSelected = !this.state.selected;

            if (this.props.onClick) {
                this.props.onClick(event, newSelected);
            }
        }
    });

    module.exports = ToggleButton;
});
