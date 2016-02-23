/**
 *
 * Copyright (c) 2016 Structured Data LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

(function(){

"use strict";

// enums will get exported

var EXEC_STATE = {
	EDIT: "edit",
	EXEC: "exec"
};

var PARSE_STATUS = {
	NULL: "",
	OK: "OK",
	INCOMPLETE: "Incomplete",
	PARSE_ERR: "ParseError",
	ERR: "Err"
};

const MAX_HISTORY_DEFAULT = 2500;

const HISTORY_KEY_DEFAULT = "shell.history";

/**
 * shell implmentation based on CodeMirror (which is awesome)
 * see http://codemirror.net/.
 *
 * Example options:
 *
 * initial_prompt: "> "
 * continuation_prompt: "+ "
 * exec_function( command, callback )
 * hint_function( line, position, callback( list, start ))
 * container: element or id, document.body
 * mode: "javascript"
 * drop_files: [ mime types ]
 * function_key_callback: called on function keys (+ some others)
 *
 */
var Shell = function( CodeMirror_, opts ){

	var cm;
	var state = EXEC_STATE.EDIT;
	var prompt = "";
	var instance = this;
	
	var prompted = false;
	var prompt_len = 0;

	var command_buffer = [];
	var paste_buffer = [];

	/**
	 * FIXME: cap and flush this thing at (X) number of lines
	 *
	 * soft persistence, meaning: up up to a command, modify it
	 * slightly, then down, up, modifications are retained.  reverts
	 * on new command.
	 */
	var history = {

		current_line: null,
		commands: [],
		actual_commands: [],
		pointer: 0,

		reset_pointer: function(){
			this.pointer = 0;
			this.commands = this.actual_commands.slice(0);
		},

		push: function( line ){
			this.actual_commands.push( line );
			this.commands = this.actual_commands.slice(0);
		},
		
		save: function(opts){
			opts = opts || {};
			var max = opts.max || MAX_HISTORY_DEFAULT;
			var key = opts.key || HISTORY_KEY_DEFAULT;
			localStorage.setItem( key, JSON.stringify( this.actual_commands.slice(0, max)));
		},
		
		restore: function(opts){
			opts = opts || {};
			var key = opts.key || HISTORY_KEY_DEFAULT;
			var val = localStorage.getItem(key);
			if( val ) this.actual_commands = JSON.parse( val );
			this.reset_pointer();
		}
		

	};

	this.setOption = function( option, value ){
		console.info( "set option", option, value );
		cm.setOption( option, value );
	};

	/**
	 * get history as array 
	 */
	this.get_history = function(){
		return history.actual_commands.slice(0);
	};

	/**
	 * insert an arbitrary node, via CM's widget
	 */
	this.insert_node = function(node){

		var doc = cm.getDoc();
		var line = Math.max( doc.lastLine() - 1, 0 );
		cm.addLineWidget( line, node, {
			handleMouseEvents: true
		});

	};

	/**
	 * handler for command responses, stuff that the system
	 * sends to the shell (callbacks, generally)
	 */
	this.response = function(text, className){

		var doc = cm.getDoc();
		var lineno = doc.lastLine();
		var end, start = lineno;

		if( text && typeof text !== "string" ){
			try { text = text.toString(); }
			catch( e ){
				text = "Unrenderable message: " + e.message;
			}
		};

		// don't add newlines.  respect existing length.  this is so we 
		// can handle \r (without a \n).  FIXME: if there's a prompt, go
		// up one line.
		
		var lastline = doc.getLine(lineno);
		var ch = lastline ? lastline.length : 0;

		// fix here in case there's already a prompt (this is a rare case?)

		if( prompted ){
			ch = 0;
		}
		
		// TEMP only (shortcut)
		var replace_end = undefined;
		if( text.startsWith( "\r" )){
			text = text.substring(1);
			replace_end = { line: start, ch: ch };
			ch = 0;	
		} 
		
		// add a newline if one is not in the message [fixme: what about continuations?]
		//if( !text || !text.match( /\n$/ )) text += "\n";

		doc.replaceRange( text, { line: start, ch: ch }, replace_end, "callback");
		end = doc.lastLine();
		lastline = doc.getLine(end);
		var endch = lastline.length;

		// can specify class
		if( className ){
			doc.markText( { line: start, ch: ch }, { line: end, ch: endch }, {
				className: className
			});
		}

		// don't scroll in exec mode, on the theory that (1) we might get
		// more messages, and (2) we'll scroll when we enter the caret
		if( state !== EXEC_STATE.EXEC ){
			cm.scrollIntoView({line: doc.lastLine(), ch: endch});
		}

	};

	/**
	 * this is history in the sense of up arrow/down arrow in the shell.
	 * it's not really connected to any underlying history (although that
	 * would probably be useful).
	 *
	 * FIXME: move more of this into the history class
	 */
	function shell_history( up ){

		if( state == EXEC_STATE.EXEC ) return;

		// can we move in this direction? [FIXME: bell?]
		if( up && history.pointer >= history.commands.length ) return;
		if( !up && history.pointer == 0 ) return;

		var doc = cm.getDoc();
		var lineno = doc.lastLine();
		var line = doc.getLine( lineno ).substr(prompt_len);

		// capture current (see history class for note on soft persistence)
		if( history.pointer == 0 ) history.current_line = line;
		else history.commands[ history.commands.length - history.pointer ] = line;

		// move
		if( up ) history.pointer++;
		else history.pointer--;

		// at current, use our buffer
		if( history.pointer == 0 ){
			doc.replaceRange( history.current_line, { line: lineno, ch: prompt_len }, {line: lineno, ch: prompt_len + line.length }, "history");
		}
		else {
			var text = history.commands[ history.commands.length - history.pointer ];
			doc.replaceRange( text,
				{ line: lineno, ch: prompt_len },
				{ line: lineno, ch: prompt_len + line.length }, "history");
		}

		var linelen = cm.getLine( lineno ).length;

		// after changing the text the caret should be at the end of the line
		// (and the line should be in view)

		cm.scrollIntoView( {line: lineno, ch: linelen });
		cm.getDoc().setSelection({ line: lineno, ch: linelen });

	}

	/**
	 * execute the current line.  this happens on enter as
	 * well as on paste (in the case of paste, it might
	 * get called multiple times -- once for each line in
	 * the paste).
	 */
	function exec_line( cm ){

		if( state == EXEC_STATE.EXEC ){
			return;
		}

		var doc = cm.getDoc();
		var lineno = doc.lastLine();
		var line = doc.getLine( lineno );

		doc.replaceRange( "\n", { line: lineno+1, ch: 0 }, undefined, "prompt");
		doc.setCursor({ line: lineno+1, ch: 0 });

		state = EXEC_STATE.EXEC;

		var command = line.substr(prompt_len);
		command_buffer.push(command);

		// you can exec an empty line, but we don't put it into history.
		// the container can just do nothing on an empty command, if it
		// wants to, but it might want to know about it.

		if( command.trim().length > 0 ){
			
			history.push(command);
			history.save(); // this is perhaps unecessarily aggressive
			
		} 

		// this automatically resets the pointer (NOT windows style)

		history.reset_pointer();

		if( instance.opts.exec_function ){
			prompted = false;
			instance.opts.exec_function.call( this, command_buffer, function(rslt){

				state = EXEC_STATE.EDIT;
				var ps = rslt ? rslt.parsestatus || PARSE_STATUS.OK : PARSE_STATUS.NULL;

				if( ps === PARSE_STATUS.INCOMPLETE ){
					prompt = instance.opts.continuation_prompt;
				}
				else {
					command_buffer = [];
					prompt = instance.opts.initial_prompt;
				}

				var lineno = cm.getDoc().lastLine();
				var lastline = cm.getLine(lineno);
				
				prompt_len = lastline.length + prompt.length;
				
				doc.replaceRange( prompt, { line: lineno, ch: lastline.length }, undefined, "prompt");
				doc.setSelection({ line: lineno, ch: prompt_len });
				cm.scrollIntoView({line: lineno, ch: prompt_len });
				prompted = true;

				if( paste_buffer.length ){
					setImmediate( function(){
						var text = paste_buffer[0];
						paste_buffer.splice(0,1);
						doc.replaceRange( text, { line: lineno, ch: prompt_len }, undefined, "paste-continuation");
						if( paste_buffer.length ){
							exec_line(cm);
						}
					});
				}

			});
		}

	}

	/**
	 * clear console. two things to note: (1) this does not work in
	 * exec state. (2) preserves last line, which we assume is a prompt/command.
	 */
	this.clear = function(){

		var doc = cm.getDoc();
		var lastline = doc.lastLine();
		if( lastline > 0 ){
			doc.replaceRange( "", { line: 0, ch: 0 }, { line: lastline, ch: 0 });
		}

	};

	/**
	 * get shell width in chars.  not sure how CM gets this (possibly a dummy node?)
	 */
	this.get_width_in_chars = function(){
		return Math.floor( this.opts.container.clientWidth / cm.defaultCharWidth()) - instance.opts.initial_prompt.length;
	};

	/** refresh layout,  force on nonstandard resizes */
	this.refresh = function(){
		cm.refresh();
	};

	/**
	 * cancel the current line; clear parse buffer and reset history.
	 */
	this.cancel = function(){

	};

	/**
	 * get current line (peek)
	 */
	this.get_current_line = function(){
		var doc = cm.getDoc();
		var index = doc.lastLine();
		var line = doc.getLine(index);
		var pos = cm.getCursor();
		return { text: line.substr( prompt_len ),
			pos: ( index == pos.line ? pos.ch - prompt_len : -1 )
		 };
	};

	/**
	 * get line caret is on.  may include prompt.
	 */
	this.get_caret_line = function(){
		var doc = cm.getDoc();
		var pos = cm.getCursor();
		var line = doc.getLine(pos.line);
		return { text: line, pos: pos.ch };
	};

	/**
	 * get selections
	 */
	this.get_selections = function(){
		return cm.getDoc().getSelections();
	};

	/**
	 * wrapper for focus call
	 */
	this.focus = function(){ cm.focus(); };

	/**
	 * constructor body
	 */
	(function(){

		opts = opts || {};

		// prompts
		opts.initial_prompt = opts.initial_prompt || "> ";
		opts.continuation_prompt = opts.continuation_prompt || "+ ";

		// dummy functions
		opts.exec_function = opts.exec_function || function( cmd, callback ){
			console.info( "DUMMY" );
			var ps = PARSE_STATUS.OK;
			var err = null;
			if( cmd.length ){
				if( cmd[cmd.length-1].match( /_\s*$/)) ps = PARSE_STATUS.INCOMPLETE;
			}
			callback.call(this, { parsestatus: ps, err: err });
		};
		opts.function_key_callback = opts.function_key_callback || function(){};

		// container is string (id) or node
		opts.container = opts.container || document.body;
		if( typeof( opts.container ) === "string" ){
			opts.container = document.querySelector(opts.container);
		}

		// FIXME: this doesn't need to be global, if we can box it up then require() it
		cm = CodeMirror_( function(elt){opts.container.appendChild( elt ); }, {
			value: opts.initial_prompt,
			mode: opts.mode,
			allowDropFileTypes: opts.drop_files,
			viewportMargin: 100
		});

		prompt = opts.initial_prompt;
		prompt_len = prompt.length;
		cm.getDoc().setSelection({ line: 0, ch: prompt_len });
		prompted = true;

		var local_hint_function = null;
		if( opts.hint_function ){
			local_hint_function = function( cm, callback ){

				var doc = cm.getDoc();
				var line = doc.getLine(doc.lastLine());
				var pos = cm.getCursor();
				var plen = prompt_len;

				opts.hint_function.call( instance, line.substr(plen), pos.ch - plen, function( completions, position ){
					if( !completions || !completions.length ){
						callback(null);
					}
					else {
						callback({ list: completions,
							from: { line: pos.line, ch: position + plen },
							to: { line: pos.line, ch: pos.ch } });
					}
				});

			};
			local_hint_function.async = true;
		}

		cm.on( "cursorActivity", function(cm, e){
			var pos = cm.getCursor();
			if( pos.line !== cm.getDoc().lastLine() || pos.ch < prompt_len || !prompted ){
				cm.setOption( "cursorBlinkRate", 0 );
			}		
			else cm.setOption( "cursorBlinkRate", 530 );
		});
				
		cm.on( "beforeChange", function(cm, e){

			// todo: split paste into separate lines,
			// paste with carets and exec in order (line-by-line)

			if( e.origin ){

				if( e.origin[0] === "+" ){
					if( state === EXEC_STATE.EXEC ) e.cancel();

					var doc = cm.getDoc();
					var lastline = doc.lastLine();
					if( e.from.line != lastline ){
						e.to.line = e.from.line = lastline;
						e.from.ch = e.to.ch = doc.getLine( lastline ).length;
					}
					else if( e.from.ch < prompt_len ){
						e.from.ch = e.to.ch = prompt_len;
					}
				}
				else if( e.origin && ( e.origin === "paste" )){
					if( state === EXEC_STATE.EXEC ) e.cancel();

					// console.info( e );

					var doc = cm.getDoc();
					var lastline = doc.lastLine();

					// text is split into multiple lines, which is handy.
					// if the last line includes a carriage return, then
					// that becomes a new (empty) entry in the array.

					if( e.from.line != lastline ){
						e.to.line = e.from.line = lastline;
						e.from.ch = e.to.ch = doc.getLine( lastline ).length;
					}
					else if( e.from.ch < prompt_len ){
						e.from.ch = e.to.ch = prompt_len;
					}

					// after adjusting for position (above), we don't
					// have to do anything for a paste w/o newline.

					if( e.text.length === 1 ) return;

					// there's a bit of weirdness with text after the
					// paste position if the paste has newlines. take whatever's
					// on the line AFTER the paste position and store that
					// in the paste array (FIXME: need to not execute it,
					// but we can't edit the document in this callback).

					// capture lines after 1

					paste_buffer = e.text.slice(1);

					// and drop from the paste

					e.text.splice(1);

					// do the exec after CM has finished processing the change

					setImmediate(function(){
						exec_line( cm );
					});

				}
			}
			// dev // else console.info( e.origin );
		});

		cm.setOption("extraKeys", {

			// command history
			Up: function(cm){ shell_history( true ); },
			Down: function(cm){ shell_history( false );},

			Esc: function(cm){
				opts.function_key_callback( 'esc' );
			},

			F3: function(cm){
				opts.function_key_callback( 'f3' );
			},

			// keep in bounds
			Left: function(cm){
				var pos = cm.getCursor();
				var doc = cm.getDoc();
				var lineno = doc.lastLine();

				if( pos.line < lineno ){
					doc.setSelection({ line: lineno, ch: doc.getLine(lineno).length });
				}
				else if( pos.ch > prompt_len ){
					doc.setSelection({ line: lineno, ch: pos.ch-1 });
				}
			},

			Right: function(cm){
				var pos = cm.getCursor();
				var doc = cm.getDoc();
				var lineno = doc.lastLine();

				if( pos.line < lineno ){
					doc.setCursor({ line: lineno, ch: doc.getLine(lineno).length });
				}
				else if( pos.ch < prompt_len ){
					doc.setCursor({ line: lineno, ch: prompt_len });
				}
				else {
					doc.setCursor({ line: lineno, ch: pos.ch+1 });
				}
			},

			'Ctrl-Left': function(cm){
				var pos = cm.getCursor();
				var doc = cm.getDoc();
				var lineno = doc.lastLine();
				if( pos.line < lineno ){
					doc.setCursor({ line: lineno, ch: doc.getLine(lineno).length });
				}
				else if( pos.ch <= prompt_len ){
					doc.setCursor({ line: lineno, ch: prompt_len });
				}
				else return CodeMirror_.Pass
			},

			'Ctrl+Right': function(cm){
				var pos = cm.getCursor();
				var doc = cm.getDoc();
				var lineno = doc.lastLine();
				if( pos.line < lineno ){
					doc.setCursor({ line: lineno, ch: doc.getLine(lineno).length });
				}
				else if( pos.ch < prompt_len ){
					doc.setCursor({ line: lineno, ch: prompt_len });
				}
				else {
					return CodeMirror_.pass;
				}

			},

			Home: function(cm){
				var doc = cm.getDoc();
				doc.setSelection({ line: doc.lastLine(), ch: prompt_len });
			},

			Tab: function(cm){
				if( opts.hint_function ){

					// we're treating this slightly differently by passing only
					// (1) the current line, and (2) the caret position in that
					// line (offset for prompt)

					cm.showHint({
						hint: local_hint_function
					});

				}
			},

			// exec
			Enter: function(cm) {
				exec_line( cm );
			}

		});

		// FIXME: optional
		history.restore();

		// expose the options object
		instance.opts = opts;

		// this is exported for debug purposes (FIXME: flag)
		if( opts.debug ) instance.cm = cm;

	})();

};

// export the enum types on the prototype
Shell.prototype.EXEC_STATE = EXEC_STATE;
Shell.prototype.PARSE_STATUS = PARSE_STATUS;

// and the factory as a module (or to the browser)
if( typeof module !== "undefined" ) module.exports = Shell;
else window.Shell = Shell;

})();
