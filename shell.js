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
const DEFAULT_PROMPT_CLASS = "shell-prompt";

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
	var prompt_text = "";
	var instance = this;
	
	var prompt_len = 0;

	var command_buffer = [];
	var paste_buffer = [];
	
	var unstyled_lines = [];
	var block_reset = [];
	
	var unstyled_flag = false;
	var cached_prompt = null;

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
			localStorage.setItem( key, JSON.stringify( this.actual_commands.slice(-max)));
		},
		
		restore: function(opts){
			opts = opts || {};
			var key = opts.key || HISTORY_KEY_DEFAULT;
			var val = localStorage.getItem(key);
			if( val ) this.actual_commands = JSON.parse( val );
			this.reset_pointer();
		}
		

	};

	/**
	 * overlay mode to support unstyled text -- file contents (the pager)
	 * in our particular case but could be anything.  this is based on 
	 * CM's "overlay" mode, but that one doesn't work because it parses
	 * regardless and we get stuck in string-mode after a stray apostrophe.
	 * 
	 * in this one, null styling is the default, and greedy; but if we are 
	 * not unstyled, then we pass through to (base).  base should be a string
	 * mode name, which must have been previously registered.
	 */
	function init_overlay_mode( CM, base, name ){
		
		CM.defineMode( name, function(config, parserConfig) {
			base = CM.getMode( config, parserConfig.backdrop || base );
			return {
				
				startState: function() {
					return {
						base: CM.startState(base),
						linecount: 0
					};
				},
				
				copyState: function(state) {
					return {
						base: CM.copyState(base, state.base),
						linecount: state.linecount
					};
				},

				token: function(stream, state) {
					if( stream.sol()){
						var lc = state.linecount;
						state.linecount++;
						if( unstyled_flag || unstyled_lines[lc] ){
							stream.skipToEnd();
							return "unstyled";
						}
						if( block_reset[lc] ){
							state.base = CM.startState(base);
						}
					}
					return base.token(stream, state.base);
					
				},

				indent: base.indent && function(state, textAfter) {
					return base.indent(state.base, textAfter);
				},
				
				electricChars: base.electricChars,

				innerMode: function(state) { return {state: state.base, mode: base}; },

				blankLine: function(state) {
					state.linecount++;
					if (base.blankLine) base.blankLine(state.base);
				}
				
			};
		});
		
	}
	
	/** set CM option directly -- REMOVE */
	this.setOption = function( option, value ){
		if( opts.debug ) console.info( "set option", option, value );
		cm.setOption( option, value );
	};

	/** 
	 * block.  this is used for operations called by the code, rather than 
	 * the user -- we don't want the user to be able to run commands, because
	 * they'll fail.
	 */
	this.block = function(message){

		// this bit is right from exec:
		
		if( state === EXEC_STATE.EXEC ){
			return false;
		}

		var doc = cm.getDoc();
		var lineno = doc.lastLine();
		var line = doc.getLine( lineno );

		if( !message ) message = "\n";
		else message = "\n" + message + "\n";

		doc.replaceRange( message, { line: lineno+1, ch: 0 }, undefined, "prompt");
		doc.setCursor({ line: lineno+1, ch: 0 });

		state = EXEC_STATE.EXEC;

		var command = line.substr(prompt_len);
		command_buffer.push(command);

		if( command.trim().length > 0 ){
			history.push(command);
			history.save(); // this is perhaps unecessarily aggressive
		} 

		// this automatically resets the pointer (NOT windows style)
		history.reset_pointer();
		
		// now leave it in this state...
		return true;
		
	};

	/** unblock, should be symmetrical. */
	this.unblock = function(rslt){

		// again this is from exec (but we're skipping the
		// bit about pasting)

		state = EXEC_STATE.EDIT;
				
		if( rslt && rslt.prompt ){
			command_buffer = [];
			set_prompt( rslt.prompt || instance.opts.initial_prompt, rslt.prompt_class, rslt.continuation );
		}
		else {
			var ps = rslt ? rslt.parsestatus || PARSE_STATUS.OK : PARSE_STATUS.NULL;
			if( ps === PARSE_STATUS.INCOMPLETE ){
				set_prompt( instance.opts.continuation_prompt, undefined, true );
			}
			else {
				command_buffer = [];
				set_prompt( instance.opts.initial_prompt );
			}
		}
		
	};

	/**
	 * get history as array 
	 */
	this.get_history = function(){
		return history.actual_commands.slice(0);
	};

	/**
	 * insert an arbitrary node, via CM's widget
	 * 
	 * @param scroll -- scroll to the following line so the node is visible 
	 */
	this.insert_node = function(node, scroll){

		var doc = cm.getDoc();
		var line = Math.max( doc.lastLine() - 1, 0 );
		cm.addLineWidget( line, node, {
			handleMouseEvents: true
		});
		if( scroll ) cm.scrollIntoView({line: line+1, ch: 0});

	};

	/**
	 * select all -- this doesn't seem to work using the standard event... ?
	 */
	this.select_all = function(){
		cm.execCommand( 'selectAll' );
	};

	/**
	 * handler for command responses, stuff that the system
	 * sends to the shell (callbacks, generally).  optional className is a
	 * style applied to the block.  "unstyled", if set, prevents language 
	 * styling on the block.
	 */
	this.response = function(text, className, unstyled){

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

		if( state !== EXEC_STATE.EXEC ){
			ch -= prompt_len;
			if( ch < 0 ) ch = 0; // how can that happen?
		}

		// second cut, a little more thorough
		// one more patch, to stop breaking on windows CRLFs
		
		var lines = text.split( "\n" );
		var replace_end = undefined;
		var inline_replacement = false;
		
		text = "";
		
		for( var i = 0; i< lines.length; i++ ){
			
			var overwrite = lines[i].split( '\r' );
			
			if( i ) text += "\n";
			else if( overwrite.length > 1 ) inline_replacement = true;
			
			if (overwrite.length > 1 ) {
				var final_text = "";
				for( var j = overwrite.length - 1; j >= 0; j-- ){
					final_text = final_text + overwrite[j].substring( final_text.length );
				}
				text += final_text;
			}
			else text += lines[i];
		}
		
		if( inline_replacement ){
			replace_end = { line: start, ch: ch };
			ch = 0;	
		}

		// for styling before we have built the table
		if( unstyled ) unstyled_flag = true;

		doc.replaceRange( text, { line: start, ch: ch }, replace_end, "callback");
		end = doc.lastLine();
		lastline = doc.getLine(end);
		var endch = lastline.length;

		if( unstyled ){
			var u_end = end;
			if( endch == 0 ) u_end--;
			if( u_end >= start ){
				for( var i = start; i<= u_end; i++ ) unstyled_lines[i] = 1;
			}
		}

		// can specify class
		if( className ){
			doc.markText( { line: start, ch: ch }, { line: end, ch: endch }, {
				className: className
			});
		}

		// don't scroll in exec mode, on the theory that (1) we might get
		// more messages, and (2) we'll scroll when we enter the caret
		//if( state !== EXEC_STATE.EXEC )
		{
			cm.scrollIntoView({line: doc.lastLine(), ch: endch});
		}

		// the problem with that is that it's annoying when you want to see 
		// the messages (for long-running code, for example).
	
		unstyled_flag = false;

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
	 * set prompt with optional class
	 */
	function set_prompt( text, prompt_class, is_continuation ){
		
		if( typeof prompt_class === "undefined" )
			prompt_class = DEFAULT_PROMPT_CLASS;

		if( typeof text === "undefined" ){
			if( instance.opts ) prompt_text = instance.opts.default_prompt;
			else text = "? " ;
		}

		prompt_text = text;	

		var doc = cm.getDoc();				
		var lineno = doc.lastLine();
		var lastline = cm.getLine(lineno);

		if( !is_continuation ) block_reset[lineno] = 1;
				
		prompt_len = lastline.length + prompt_text.length;
				
		doc.replaceRange( prompt_text, { line: lineno, ch: lastline.length }, undefined, "prompt" );
		if( prompt_class ){
			doc.markText( { line: lineno, ch: lastline.length }, { line: lineno, ch: prompt_len }, {
				className: prompt_class
			});
		}
				
		doc.setSelection({ line: lineno, ch: prompt_len });
		cm.scrollIntoView({line: lineno, ch: prompt_len });

	}

	/**
	 * external function to set a prompt.  this is intended to be used with
	 * a delayed startup, where there may be text echoed to the screen (and 
	 * hence we need an initialized console) before we know what the correct
	 * prompt is.
	 */
	this.prompt = function( text, className, is_continuation ){
		set_prompt( text, className, is_continuation );	
	};

	/**
	 * execute the current line.  this happens on enter as
	 * well as on paste (in the case of paste, it might
	 * get called multiple times -- once for each line in
	 * the paste).
	 */
	function exec_line( cm, cancel ){

		if( state === EXEC_STATE.EXEC ){
			return;
		}

		var doc = cm.getDoc();
		var lineno = doc.lastLine();
		var line = doc.getLine( lineno );

		doc.replaceRange( "\n", { line: lineno+1, ch: 0 }, undefined, "prompt");
		doc.setCursor({ line: lineno+1, ch: 0 });

		state = EXEC_STATE.EXEC;
		var command;

		if( cancel ){
			command = "";
			command_buffer = [command];
		}
		else {
			command = line.substr(prompt_len);
			command_buffer.push(command);
			
		}

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
			instance.opts.exec_function.call( this, command_buffer, function(rslt){

				// UPDATE: new style of return where the command processor 
				// handles the multiline-buffer (specifically for R's debugger).
				
				// in that case, always clear command buffer and accept the prompt
				// from the callback.

				state = EXEC_STATE.EDIT;
				
				if( rslt && rslt.prompt ){
					command_buffer = [];
					set_prompt( rslt.prompt || instance.opts.initial_prompt, rslt.prompt_class, rslt.continuation );
				}
				else {
					var ps = rslt ? rslt.parsestatus || PARSE_STATUS.OK : PARSE_STATUS.NULL;
					if( ps === PARSE_STATUS.INCOMPLETE ){
						set_prompt( instance.opts.continuation_prompt, undefined, true );
					}
					else {
						command_buffer = [];
						set_prompt( instance.opts.initial_prompt );
					}
				}
				
				lineno = cm.getDoc().lastLine();
				
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
	this.clear = function(focus){

		var doc = cm.getDoc();
		var lastline = doc.lastLine();
		if( lastline > 0 ){
			doc.replaceRange( "", { line: 0, ch: 0 }, { line: lastline, ch: 0 });
		}
		
		// reset unstyled 
		unstyled_lines.splice(0, unstyled_lines.length);
		unstyled_flag = false;

		block_reset.splice(0, block_reset.length);
		
		// move cursor to edit position 
		var text = doc.getLine( doc.lastLine());
		doc.setSelection({ line: doc.lastLine(), ch: text.length });

		// optionally focus		
		if( focus ) this.focus();
		
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
		exec_line( cm, true );
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
	 * show function tip
	 */
	this.show_function_tip = function( text ){
		
		if( !this.function_tip ) this.function_tip = {};
		if( text === this.function_tip.cached_tip ) return;
		var where = cm.cursorCoords();
		this.function_tip.cached_tip = text;
		if( !this.function_tip.node ){
			this.function_tip.container_node = document.createElement( "div" );
			this.function_tip.container_node.className = "cmjs-shell-function-tip-container";
			this.function_tip.node = document.createElement( "div" );
			this.function_tip.node.className = "cmjs-shell-function-tip";
			this.function_tip.container_node.appendChild( this.function_tip.node );
			opts.container.appendChild(this.function_tip.container_node);
		}
		this.function_tip.visible = true;
		this.function_tip.node.innerHTML = text;

		// the container/child lets you relatively position the tip in css
		this.function_tip.container_node.setAttribute( "style", "top: " + where.top + "px; left: " + where.left + "px;" );
		this.function_tip.container_node.classList.add( "visible" );
	};

	/**
	 * hide function tip.  
	 * 
	 * @return true if we consumed the event, or false
	 */
	this.hide_function_tip = function( user ){
		if( !this.function_tip ) return false;
		if( !user ) this.function_tip.cached_tip = null;
		if( this.function_tip.visible ){
			this.function_tip.container_node.classList.remove( "visible" );
			this.function_tip.visible = false;
			return true;
		}
		return false;
	};

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
			if( opts.debug ) console.info( "DUMMY" );
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

		// special codemirror mode to support unstyled blocks (full lines only)
		var modename = "unstyled-overlay";
		init_overlay_mode( CodeMirror_, opts.mode, modename );
		
		// FIXME: this doesn't need to be global, if we can box it up then require() it
		cm = CodeMirror_( function(elt){opts.container.appendChild( elt ); }, {
			value: "",
			mode: modename, // opts.mode,
			allowDropFileTypes: opts.drop_files,
			viewportMargin: 100
		});

		// if you suppress the initial prompt, you must call the "prompt" method 
	
		if( !opts.suppress_initial_prompt ) set_prompt( opts.initial_prompt );
		
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

		cm.on( "cut", function( cm, e ){
			if( state !== EXEC_STATE.EDIT ) e.preventDefault();
			else {
				var doc = cm.getDoc();
				var start = doc.getCursor( "from" );
				var end = doc.getCursor( "to" );
				var line = doc.lastLine();
				if( start.line !== line 
					|| end.line !== line 
					|| start.ch < prompt_len 
					|| end.ch < prompt_len 
					|| start.ch === end.ch ) e.preventDefault();
			}
		});

		cm.on( "cursorActivity", function(cm, e){
			var pos = cm.getCursor();
			var doc = cm.getDoc();
			var lineno = doc.lastLine();
			var lastline = doc.getLine( lineno );
			if( pos.line !== lineno || pos.ch < prompt_len ){
				cm.setOption( "cursorBlinkRate", 0 );
			}
			else if( state === EXEC_STATE.EXEC 
					&& pos.line === lineno 
					&& pos.ch == lastline.length ){
				cm.setOption( "cursorBlinkRate", -1 );
			}
			else cm.setOption( "cursorBlinkRate", 530 ); // CM default -- make an option?
		});
				
		cm.on( "change", function( cm, e ){
			if( e.origin && e.origin[0] === "+" ){
				var doc = cm.getDoc();
				var lastline = doc.lastLine();
				if( opts.tip_function ) opts.tip_function( doc.getLine( lastline ), e.from.ch + e.text.length );
			}
			else {
				instance.hide_function_tip( true );
			}
		});
				
		cm.on( "beforeChange", function(cm, e){

			// todo: split paste into separate lines,
			// paste with carets and exec in order (line-by-line)

			if( e.origin ){
				
				var doc = cm.getDoc();
				var lastline = doc.lastLine();

				if( e.origin[0] === "+" ){
					if( state === EXEC_STATE.EXEC ) e.cancel();
					if( e.from.line != lastline ){
						e.to.line = e.from.line = lastline;
						e.from.ch = e.to.ch = doc.getLine( lastline ).length;
					}
					else if( e.from.ch < prompt_len ){
						e.from.ch = e.to.ch = prompt_len;
					}
				}
				else if( e.origin === "undo" ){
					if( state !== EXEC_STATE.EDIT ) e.cancel();
					if( e.from.line !== lastline 
						|| e.to.line !== lastline 
						|| e.from.ch < prompt_len 
						|| e.to.ch < prompt_len 
						|| e.from.ch === e.to.ch ) e.cancel();
				}
				else if( e.origin === "paste" ){
					if( state !== EXEC_STATE.EDIT ) e.cancel();

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
				
				// don't pass through if we consume it

				if( !instance.hide_function_tip( true ))
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
