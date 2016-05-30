"use strict";

import * as _ from 'lodash';
import * as vscode from 'vscode';

import { Mode, ModeName } from './mode';
import { Motion, MotionMode } from './../motion/motion';
import { NormalMode } from './modeNormal';
import { InsertMode } from './modeInsert';
import { VisualMode } from './modeVisual';
import { BaseMovement, BaseAction, Actions } from './../actions/actions';
import { BaseOperator } from './../operator/operator';
import { Configuration } from '../configuration/configuration';
import { DeleteOperator } from './../operator/delete';
import { ChangeOperator } from './../operator/change';
import { PutOperator } from './../operator/put';
import { YankOperator } from './../operator/yank';
import { Position } from './../motion/position';


// TODO: This is REALLY dumb...
// figure out some way to force include this stuff...
new DeleteOperator();
new ChangeOperator();
new PutOperator();
new YankOperator();
// TODO - or maybe just get rid of decorators
// they're nice but introduce a weird class of bugs ;_;


/**
 * The ActionState class represents state relevant to the current
 * action that the user is doing. Example: Imagine that the user types:
 *
 * 5"qdw
 *
 * Then the relevent state would be
 *   * count of 5
 *   * copy into q register
 *   * delete operator
 *   * word movement
 */
export class ActionState {
    /**
     * Keeps track of the most recent keys pressed. Comes in handy when parsing
     * multiple length movements, e.g. gg.
     */
    public keysPressed: string[] = [];

    /**
     * The operator (e.g. d, y, >>) the user wants to run, if there is one.
     */
    public operator: BaseOperator = undefined;

    public motionStart: Position;

    public motionStop: Position;

    /**
     * The number of times the user wants to repeat this command.
     */
    public count: number = 1;

    public getAction(): BaseAction {
        for (let window = this.keysPressed.length; window > 0; window--) {
            let keysPressed = _.takeRight(this.keysPressed, window).join('');
            let action = Actions.getRelevantAction(keysPressed);

            if (action) {
                this.keysPressed = [];
                return action;
            }
        }
    }
}

export class ModeHandler implements vscode.Disposable {
    private _motion: Motion;
    private _modes: Mode[];
    private _statusBarItem: vscode.StatusBarItem;
    private _configuration: Configuration;
    private _actionState: ActionState;

    constructor() {
        this._configuration = Configuration.fromUserFile();

        this._motion = new Motion(null);
        this._modes = [
            new NormalMode(this._motion, this, this._configuration.commandKeyMap.normalModeKeyMap),
            new InsertMode(this._motion, this._configuration.commandKeyMap.insertModeKeyMap),
            new VisualMode(this._motion, this, this._configuration.commandKeyMap.visualModeKeyMap),
        ];

        this.setCurrentModeByName(ModeName.Normal);
    }

    /**
     * The active mode.
     */
    get currentMode() : Mode {
        return this._modes.find(mode => mode.isActive);
    }

    setNormal() {
        this.setCurrentModeByName(ModeName.Normal);
    }

    setCurrentModeByName(modeName : ModeName) {
        for (let mode of this._modes) {
            mode.isActive = (mode.name === modeName);
        }

        switch (modeName) {
            case ModeName.Insert:
                this._motion = this._motion.changeMode(MotionMode.Cursor);
                break;

            case ModeName.Normal:
                this._motion = this._motion.changeMode(MotionMode.Caret);
                break;
        }

        const statusBarText = (this.currentMode.name === ModeName.Normal) ? '' : ModeName[modeName];
        this.setupStatusBarItem(statusBarText ? `-- ${statusBarText.toUpperCase()} --` : '');
    }

    async handleKeyEvent(key : string) : Promise<Boolean> {
        // Due to a limitation in Electron, en-US QWERTY char codes are used in international keyboards.
        // We'll try to mitigate this problem until it's fixed upstream.
        // https://github.com/Microsoft/vscode/issues/713
        key = this._configuration.keyboardLayout.translate(key);

        let currentModeName = this.currentMode.name;
        let nextMode: Mode;
        let inactiveModes = _.filter(this._modes, (m) => !m.isActive);

        for (let mode of inactiveModes) {
          if (mode.shouldBeActivated(key, currentModeName)) {
            if (nextMode) {
              console.error("More that one mode matched in handleKeyEvent!");
            }

            nextMode = mode;
          }
        }


        if (nextMode) {
            this.currentMode.handleDeactivation();
            this.setCurrentModeByName(nextMode.name);

            await nextMode.handleActivation(key);

            this._actionState = new ActionState();

            return true;
        }

        this._actionState.keysPressed.push(key);

        if (currentModeName === ModeName.Insert) {
            // TODO: Getting less dumb, but I still feel like this can be
            // handled more elegantly.

            // Especially since vim considers iasdfg<esc> a single action.

            await this.currentMode.handleAction(this._actionState);
            this._actionState = new ActionState();

            return true;
        }

        let action = this._actionState.getAction();
        let readyToExecute = false;

        // update our state appropriately. If the action is complete, flag that
        // we are ready to transform the document.
        if (action) {
            if (action instanceof BaseMovement) {
                this._actionState.motionStart = this._motion.position;
                this._actionState.motionStop = await action.execAction(this, this._motion.position);

                readyToExecute = true;
            }

            if (action instanceof BaseOperator) {
                if (this.currentMode instanceof VisualMode) {
                    this._actionState.motionStart = (this.currentMode as VisualMode).selectionStart;
                    this._actionState.motionStop = (this.currentMode as VisualMode).selectionStop;

                    readyToExecute = true;
                } else if (currentModeName === ModeName.VisualLine) {
                    console.log("TODO -- handle visual line operators! (should be easy...)");

                    return false;
                }

                this._actionState.operator = action;
            }
        }

        if (readyToExecute) {
            if (this._actionState.operator) {
                await this._actionState.operator.run(this, this._actionState.motionStart, this._actionState.motionStop);
            } else {
                let stop = this._actionState.motionStop;

                if (this.currentMode instanceof NormalMode) {
                    this._motion.moveTo(stop.line, stop.character);
                } else if (this.currentMode instanceof VisualMode) {
                    await (this.currentMode as VisualMode).handleMotion(stop);
                } else {
                    console.log("TODO: My janky thing doesn't handle this case!");
                }
            }

            this._actionState = new ActionState();
        }

        return !!action;
    }

    async handleMultipleKeyEvents(keys: string[]): Promise<void> {
        for (const key of keys) {
            await this.handleKeyEvent(key);
        }
    }

    setupStatusBarItem(text : string) : void {
        if (!this._statusBarItem) {
            this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        }

        this._statusBarItem.text = text || '';
        this._statusBarItem.show();
    }

    dispose() {
        this._statusBarItem.hide();
        this._statusBarItem.dispose();
        this._motion.dispose();
    }
}