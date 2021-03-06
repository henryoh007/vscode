/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import * as strings from 'vs/base/common/strings';
import { CharCode } from 'vs/base/common/charCode';
import Event, { Emitter } from 'vs/base/common/event';
import { Range, IRange } from 'vs/editor/common/core/range';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { TextModelWithTokens } from 'vs/editor/common/model/textModelWithTokens';
import { LanguageIdentifier } from 'vs/editor/common/modes';
import { ITextSource, IRawTextSource } from 'vs/editor/common/model/textSource';
import { IModelDecorationsChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { ThemeColor } from 'vs/platform/theme/common/themeService';
import { IntervalNode, IntervalTree, recomputeMaxEnd, getNodeIsInOverviewRuler } from 'vs/editor/common/model/intervalTree';
import { Disposable } from 'vs/base/common/lifecycle';

let _INSTANCE_COUNT = 0;
/**
 * Produces 'a'-'z', followed by 'A'-'Z'... followed by 'a'-'z', etc.
 */
function nextInstanceId(): string {
	const LETTERS_CNT = (CharCode.Z - CharCode.A + 1);

	let result = _INSTANCE_COUNT++;
	result = result % (2 * LETTERS_CNT);

	if (result < LETTERS_CNT) {
		return String.fromCharCode(CharCode.a + result);
	}

	return String.fromCharCode(CharCode.A + result - LETTERS_CNT);
}

export class TextModelWithDecorations extends TextModelWithTokens implements editorCommon.ITextModelWithDecorations {

	protected readonly _onDidChangeDecorations: DidChangeDecorationsEmitter = this._register(new DidChangeDecorationsEmitter());
	public readonly onDidChangeDecorations: Event<IModelDecorationsChangedEvent> = this._onDidChangeDecorations.event;

	/**
	 * Used to workaround broken clients that might attempt using a decoration id generated by a different model.
	 * It is not globally unique in order to limit it to one character.
	 */
	private readonly _instanceId: string;
	private _lastDecorationId: number;
	private _decorations: { [decorationId: string]: IntervalNode; };
	private _decorationsTree: DecorationsTrees;

	constructor(rawTextSource: IRawTextSource, creationOptions: editorCommon.ITextModelCreationOptions, languageIdentifier: LanguageIdentifier) {
		super(rawTextSource, creationOptions, languageIdentifier);

		this._instanceId = nextInstanceId();
		this._lastDecorationId = 0;
		this._decorations = Object.create(null);
		this._decorationsTree = new DecorationsTrees();
	}

	public dispose(): void {
		this._decorations = null;
		this._decorationsTree = null;

		super.dispose();
	}

	protected _resetValue(newValue: ITextSource): void {
		super._resetValue(newValue);

		// Destroy all my decorations
		this._decorations = Object.create(null);
		this._decorationsTree = new DecorationsTrees();
	}

	// --- END TrackedRanges

	protected _adjustDecorationsForEdit(offset: number, length: number, textLength: number, forceMoveMarkers: boolean): void {
		this._onDidChangeDecorations.fire();
		this._decorationsTree.acceptReplace(offset, length, textLength, forceMoveMarkers);
	}

	protected _onBeforeEOLChange(): void {
		super._onBeforeEOLChange();

		// Ensure all decorations get their `range` set.
		const versionId = this.getVersionId();
		const allDecorations = this._decorationsTree.search(0, false, false, versionId);
		this._ensureNodesHaveRanges(allDecorations);
	}

	protected _onAfterEOLChange(): void {
		super._onAfterEOLChange();

		// Transform back `range` to offsets
		const versionId = this.getVersionId();
		const allDecorations = this._decorationsTree.collectNodesPostOrder();
		for (let i = 0, len = allDecorations.length; i < len; i++) {
			const node = allDecorations[i];

			const delta = node.cachedAbsoluteStart - node.start;

			const startOffset = this._lineStarts.getAccumulatedValue(node.range.startLineNumber - 2) + node.range.startColumn - 1;
			const endOffset = this._lineStarts.getAccumulatedValue(node.range.endLineNumber - 2) + node.range.endColumn - 1;

			node.cachedAbsoluteStart = startOffset;
			node.cachedAbsoluteEnd = endOffset;
			node.cachedVersionId = versionId;

			node.start = startOffset - delta;
			node.end = endOffset - delta;

			recomputeMaxEnd(node);
		}
	}

	public changeDecorations<T>(callback: (changeAccessor: editorCommon.IModelDecorationsChangeAccessor) => T, ownerId: number = 0): T {
		this._assertNotDisposed();

		try {
			this._onDidChangeDecorations.beginDeferredEmit();
			return this._changeDecorations(ownerId, callback);
		} finally {
			this._onDidChangeDecorations.endDeferredEmit();
		}
	}

	private _changeDecorations<T>(ownerId: number, callback: (changeAccessor: editorCommon.IModelDecorationsChangeAccessor) => T): T {
		let changeAccessor: editorCommon.IModelDecorationsChangeAccessor = {
			addDecoration: (range: IRange, options: editorCommon.IModelDecorationOptions): string => {
				this._onDidChangeDecorations.fire();
				return this._deltaDecorationsImpl(ownerId, [], [{ range: range, options: options }])[0];
			},
			changeDecoration: (id: string, newRange: IRange): void => {
				this._onDidChangeDecorations.fire();
				this._changeDecorationImpl(id, newRange);
			},
			changeDecorationOptions: (id: string, options: editorCommon.IModelDecorationOptions) => {
				this._onDidChangeDecorations.fire();
				this._changeDecorationOptionsImpl(id, _normalizeOptions(options));
			},
			removeDecoration: (id: string): void => {
				this._onDidChangeDecorations.fire();
				this._deltaDecorationsImpl(ownerId, [id], []);
			},
			deltaDecorations: (oldDecorations: string[], newDecorations: editorCommon.IModelDeltaDecoration[]): string[] => {
				if (oldDecorations.length === 0 && newDecorations.length === 0) {
					// nothing to do
					return [];
				}
				this._onDidChangeDecorations.fire();
				return this._deltaDecorationsImpl(ownerId, oldDecorations, newDecorations);
			}
		};
		let result: T = null;
		try {
			result = callback(changeAccessor);
		} catch (e) {
			onUnexpectedError(e);
		}
		// Invalidate change accessor
		changeAccessor.addDecoration = null;
		changeAccessor.changeDecoration = null;
		changeAccessor.removeDecoration = null;
		changeAccessor.deltaDecorations = null;
		return result;
	}

	public deltaDecorations(oldDecorations: string[], newDecorations: editorCommon.IModelDeltaDecoration[], ownerId: number = 0): string[] {
		this._assertNotDisposed();
		if (!oldDecorations) {
			oldDecorations = [];
		}
		if (oldDecorations.length === 0 && newDecorations.length === 0) {
			// nothing to do
			return [];
		}

		try {
			this._onDidChangeDecorations.beginDeferredEmit();
			this._onDidChangeDecorations.fire();
			return this._deltaDecorationsImpl(ownerId, oldDecorations, newDecorations);
		} finally {
			this._onDidChangeDecorations.endDeferredEmit();
		}
	}

	_getTrackedRange(id: string): Range {
		return this.getDecorationRange(id);
	}

	_setTrackedRange(id: string, newRange: Range, newStickiness: editorCommon.TrackedRangeStickiness): string {
		const node = (id ? this._decorations[id] : null);

		if (!node) {
			if (!newRange) {
				// node doesn't exist, the request is to delete => nothing to do
				return null;
			}
			// node doesn't exist, the request is to set => add the tracked range
			return this._deltaDecorationsImpl(0, [], [{ range: newRange, options: TRACKED_RANGE_OPTIONS[newStickiness] }])[0];
		}

		if (!newRange) {
			// node exists, the request is to delete => delete node
			this._decorationsTree.delete(node);
			delete this._decorations[node.id];
			return null;
		}

		// node exists, the request is to set => change the tracked range and its options
		const range = this._validateRangeRelaxedNoAllocations(newRange);
		const startOffset = this._lineStarts.getAccumulatedValue(range.startLineNumber - 2) + range.startColumn - 1;
		const endOffset = this._lineStarts.getAccumulatedValue(range.endLineNumber - 2) + range.endColumn - 1;
		this._decorationsTree.delete(node);
		node.reset(this.getVersionId(), startOffset, endOffset, range);
		node.setOptions(TRACKED_RANGE_OPTIONS[newStickiness]);
		this._decorationsTree.insert(node);
		return node.id;
	}

	public removeAllDecorationsWithOwnerId(ownerId: number): void {
		if (this._isDisposed) {
			return;
		}
		const nodes = this._decorationsTree.collectNodesFromOwner(ownerId);
		for (let i = 0, len = nodes.length; i < len; i++) {
			const node = nodes[i];

			this._decorationsTree.delete(node);
			delete this._decorations[node.id];
		}
	}

	public getDecorationOptions(decorationId: string): editorCommon.IModelDecorationOptions {
		const node = this._decorations[decorationId];
		if (!node) {
			return null;
		}
		return node.options;
	}

	public getDecorationRange(decorationId: string): Range {
		const node = this._decorations[decorationId];
		if (!node) {
			return null;
		}
		const versionId = this.getVersionId();
		if (node.cachedVersionId !== versionId) {
			this._decorationsTree.resolveNode(node, versionId);
		}
		if (node.range === null) {
			node.range = this._getRangeAt(node.cachedAbsoluteStart, node.cachedAbsoluteEnd);
		}
		return node.range;
	}

	public getLineDecorations(lineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			return [];
		}

		return this.getLinesDecorations(lineNumber, lineNumber, ownerId, filterOutValidation);
	}

	public getLinesDecorations(_startLineNumber: number, _endLineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		let lineCount = this.getLineCount();
		let startLineNumber = Math.min(lineCount, Math.max(1, _startLineNumber));
		let endLineNumber = Math.min(lineCount, Math.max(1, _endLineNumber));
		let endColumn = this.getLineMaxColumn(endLineNumber);
		return this._getDecorationsInRange(new Range(startLineNumber, 1, endLineNumber, endColumn), ownerId, filterOutValidation);
	}

	public getDecorationsInRange(range: IRange, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		let validatedRange = this.validateRange(range);
		return this._getDecorationsInRange(validatedRange, ownerId, filterOutValidation);
	}

	public getOverviewRulerDecorations(ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		const versionId = this.getVersionId();
		const result = this._decorationsTree.search(ownerId, filterOutValidation, true, versionId);
		return this._ensureNodesHaveRanges(result);
	}

	public getAllDecorations(ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		const versionId = this.getVersionId();
		const result = this._decorationsTree.search(ownerId, filterOutValidation, false, versionId);
		return this._ensureNodesHaveRanges(result);
	}

	private _getDecorationsInRange(filterRange: Range, filterOwnerId: number, filterOutValidation: boolean): IntervalNode[] {
		const startOffset = this._lineStarts.getAccumulatedValue(filterRange.startLineNumber - 2) + filterRange.startColumn - 1;
		const endOffset = this._lineStarts.getAccumulatedValue(filterRange.endLineNumber - 2) + filterRange.endColumn - 1;

		const versionId = this.getVersionId();
		const result = this._decorationsTree.intervalSearch(startOffset, endOffset, filterOwnerId, filterOutValidation, versionId);

		return this._ensureNodesHaveRanges(result);
	}

	private _ensureNodesHaveRanges(nodes: IntervalNode[]): IntervalNode[] {
		for (let i = 0, len = nodes.length; i < len; i++) {
			const node = nodes[i];
			if (node.range === null) {
				node.range = this._getRangeAt(node.cachedAbsoluteStart, node.cachedAbsoluteEnd);
			}
		}
		return nodes;
	}

	private _getRangeAt(start: number, end: number): Range {
		const startResult = this._lineStarts.getIndexOf(start);
		const startLineLength = this._lines[startResult.index].text.length;
		const startColumn = Math.min(startResult.remainder + 1, startLineLength + 1);

		const endResult = this._lineStarts.getIndexOf(end);
		const endLineLength = this._lines[endResult.index].text.length;
		const endColumn = Math.min(endResult.remainder + 1, endLineLength + 1);

		return new Range(startResult.index + 1, startColumn, endResult.index + 1, endColumn);
	}

	private _changeDecorationImpl(decorationId: string, _range: IRange): void {
		const node = this._decorations[decorationId];
		if (!node) {
			return;
		}
		const range = this._validateRangeRelaxedNoAllocations(_range);
		const startOffset = this._lineStarts.getAccumulatedValue(range.startLineNumber - 2) + range.startColumn - 1;
		const endOffset = this._lineStarts.getAccumulatedValue(range.endLineNumber - 2) + range.endColumn - 1;

		this._decorationsTree.delete(node);
		node.reset(this.getVersionId(), startOffset, endOffset, range);
		this._decorationsTree.insert(node);
	}

	private _changeDecorationOptionsImpl(decorationId: string, options: ModelDecorationOptions): void {
		const node = this._decorations[decorationId];
		if (!node) {
			return;
		}

		const nodeWasInOverviewRuler = (node.options.overviewRuler.color ? true : false);
		const nodeIsInOverviewRuler = (options.overviewRuler.color ? true : false);

		if (nodeWasInOverviewRuler !== nodeIsInOverviewRuler) {
			// Delete + Insert due to an overview ruler status change
			this._decorationsTree.delete(node);
			node.setOptions(options);
			this._decorationsTree.insert(node);
		} else {
			node.setOptions(options);
		}
	}

	private _deltaDecorationsImpl(ownerId: number, oldDecorationsIds: string[], newDecorations: editorCommon.IModelDeltaDecoration[]): string[] {
		const versionId = this.getVersionId();

		const oldDecorationsLen = oldDecorationsIds.length;
		let oldDecorationIndex = 0;

		const newDecorationsLen = newDecorations.length;
		let newDecorationIndex = 0;

		let result = new Array<string>(newDecorationsLen);
		while (oldDecorationIndex < oldDecorationsLen || newDecorationIndex < newDecorationsLen) {

			let node: IntervalNode = null;

			if (oldDecorationIndex < oldDecorationsLen) {
				// (1) get ourselves an old node
				do {
					node = this._decorations[oldDecorationsIds[oldDecorationIndex++]];
				} while (!node && oldDecorationIndex < oldDecorationsLen);

				// (2) remove the node from the tree (if it exists)
				if (node) {
					this._decorationsTree.delete(node);
				}
			}

			if (newDecorationIndex < newDecorationsLen) {
				// (3) create a new node if necessary
				if (!node) {
					const internalDecorationId = (++this._lastDecorationId);
					const decorationId = `${this._instanceId};${internalDecorationId}`;
					node = new IntervalNode(decorationId, 0, 0);
					this._decorations[decorationId] = node;
				}

				// (4) initialize node
				const newDecoration = newDecorations[newDecorationIndex];
				const range = this._validateRangeRelaxedNoAllocations(newDecoration.range);
				const options = _normalizeOptions(newDecoration.options);
				const startOffset = this._lineStarts.getAccumulatedValue(range.startLineNumber - 2) + range.startColumn - 1;
				const endOffset = this._lineStarts.getAccumulatedValue(range.endLineNumber - 2) + range.endColumn - 1;

				node.ownerId = ownerId;
				node.reset(versionId, startOffset, endOffset, range);
				node.setOptions(options);

				this._decorationsTree.insert(node);

				result[newDecorationIndex] = node.id;

				newDecorationIndex++;
			} else {
				if (node) {
					delete this._decorations[node.id];
				}
			}
		}

		return result;
	}
}

class DecorationsTrees {

	/**
	 * This tree holds decorations that do not show up in the overview ruler.
	 */
	private _decorationsTree0: IntervalTree;

	/**
	 * This tree holds decorations that show up in the overview ruler.
	 */
	private _decorationsTree1: IntervalTree;

	constructor() {
		this._decorationsTree0 = new IntervalTree();
		this._decorationsTree1 = new IntervalTree();
	}

	public intervalSearch(start: number, end: number, filterOwnerId: number, filterOutValidation: boolean, cachedVersionId: number): IntervalNode[] {
		const r0 = this._decorationsTree0.intervalSearch(start, end, filterOwnerId, filterOutValidation, cachedVersionId);
		const r1 = this._decorationsTree1.intervalSearch(start, end, filterOwnerId, filterOutValidation, cachedVersionId);
		return r0.concat(r1);
	}

	public search(filterOwnerId: number, filterOutValidation: boolean, overviewRulerOnly: boolean, cachedVersionId: number): IntervalNode[] {
		if (overviewRulerOnly) {
			return this._decorationsTree1.search(filterOwnerId, filterOutValidation, cachedVersionId);
		} else {
			const r0 = this._decorationsTree0.search(filterOwnerId, filterOutValidation, cachedVersionId);
			const r1 = this._decorationsTree1.search(filterOwnerId, filterOutValidation, cachedVersionId);
			return r0.concat(r1);
		}
	}

	public collectNodesFromOwner(ownerId: number): IntervalNode[] {
		const r0 = this._decorationsTree0.collectNodesFromOwner(ownerId);
		const r1 = this._decorationsTree1.collectNodesFromOwner(ownerId);
		return r0.concat(r1);
	}

	public collectNodesPostOrder(): IntervalNode[] {
		const r0 = this._decorationsTree0.collectNodesPostOrder();
		const r1 = this._decorationsTree1.collectNodesPostOrder();
		return r0.concat(r1);
	}

	public insert(node: IntervalNode): void {
		if (getNodeIsInOverviewRuler(node)) {
			this._decorationsTree1.insert(node);
		} else {
			this._decorationsTree0.insert(node);
		}
	}

	public delete(node: IntervalNode): void {
		if (getNodeIsInOverviewRuler(node)) {
			this._decorationsTree1.delete(node);
		} else {
			this._decorationsTree0.delete(node);
		}
	}

	public resolveNode(node: IntervalNode, cachedVersionId: number): void {
		if (getNodeIsInOverviewRuler(node)) {
			this._decorationsTree1.resolveNode(node, cachedVersionId);
		} else {
			this._decorationsTree0.resolveNode(node, cachedVersionId);
		}
	}

	public acceptReplace(offset: number, length: number, textLength: number, forceMoveMarkers: boolean): void {
		this._decorationsTree0.acceptReplace(offset, length, textLength, forceMoveMarkers);
		this._decorationsTree1.acceptReplace(offset, length, textLength, forceMoveMarkers);
	}
}

function cleanClassName(className: string): string {
	return className.replace(/[^a-z0-9\-]/gi, ' ');
}

export class ModelDecorationOverviewRulerOptions implements editorCommon.IModelDecorationOverviewRulerOptions {
	readonly color: string | ThemeColor;
	readonly darkColor: string | ThemeColor;
	readonly hcColor: string | ThemeColor;
	readonly position: editorCommon.OverviewRulerLane;
	_resolvedColor: string;

	constructor(options: editorCommon.IModelDecorationOverviewRulerOptions) {
		this.color = strings.empty;
		this.darkColor = strings.empty;
		this.hcColor = strings.empty;
		this.position = editorCommon.OverviewRulerLane.Center;
		this._resolvedColor = null;

		if (options && options.color) {
			this.color = options.color;
		}
		if (options && options.darkColor) {
			this.darkColor = options.darkColor;
			this.hcColor = options.darkColor;
		}
		if (options && options.hcColor) {
			this.hcColor = options.hcColor;
		}
		if (options && options.hasOwnProperty('position')) {
			this.position = options.position;
		}
	}
}

let lastStaticId = 0;

export class ModelDecorationOptions implements editorCommon.IModelDecorationOptions {

	public static EMPTY: ModelDecorationOptions;

	public static register(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
		return new ModelDecorationOptions(++lastStaticId, options);
	}

	public static createDynamic(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
		return new ModelDecorationOptions(0, options);
	}

	readonly staticId: number;
	readonly stickiness: editorCommon.TrackedRangeStickiness;
	readonly className: string;
	readonly hoverMessage: IMarkdownString | IMarkdownString[];
	readonly glyphMarginHoverMessage: IMarkdownString | IMarkdownString[];
	readonly isWholeLine: boolean;
	readonly showIfCollapsed: boolean;
	readonly overviewRuler: ModelDecorationOverviewRulerOptions;
	readonly glyphMarginClassName: string;
	readonly linesDecorationsClassName: string;
	readonly marginClassName: string;
	readonly inlineClassName: string;
	readonly beforeContentClassName: string;
	readonly afterContentClassName: string;

	private constructor(staticId: number, options: editorCommon.IModelDecorationOptions) {
		this.staticId = staticId;
		this.stickiness = options.stickiness || editorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
		this.className = options.className ? cleanClassName(options.className) : strings.empty;
		this.hoverMessage = options.hoverMessage || [];
		this.glyphMarginHoverMessage = options.glyphMarginHoverMessage || [];
		this.isWholeLine = options.isWholeLine || false;
		this.showIfCollapsed = options.showIfCollapsed || false;
		this.overviewRuler = new ModelDecorationOverviewRulerOptions(options.overviewRuler);
		this.glyphMarginClassName = options.glyphMarginClassName ? cleanClassName(options.glyphMarginClassName) : strings.empty;
		this.linesDecorationsClassName = options.linesDecorationsClassName ? cleanClassName(options.linesDecorationsClassName) : strings.empty;
		this.marginClassName = options.marginClassName ? cleanClassName(options.marginClassName) : strings.empty;
		this.inlineClassName = options.inlineClassName ? cleanClassName(options.inlineClassName) : strings.empty;
		this.beforeContentClassName = options.beforeContentClassName ? cleanClassName(options.beforeContentClassName) : strings.empty;
		this.afterContentClassName = options.afterContentClassName ? cleanClassName(options.afterContentClassName) : strings.empty;
	}
}
ModelDecorationOptions.EMPTY = ModelDecorationOptions.register({});

/**
 * The order carefully matches the values of the enum.
 */
const TRACKED_RANGE_OPTIONS = [
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges }),
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }),
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore }),
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter }),
];

function _normalizeOptions(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
	if (options instanceof ModelDecorationOptions) {
		return options;
	}
	return ModelDecorationOptions.createDynamic(options);
}

export class DidChangeDecorationsEmitter extends Disposable {

	private readonly _actual: Emitter<IModelDecorationsChangedEvent> = this._register(new Emitter<IModelDecorationsChangedEvent>());
	public readonly event: Event<IModelDecorationsChangedEvent> = this._actual.event;

	private _deferredCnt: number;
	private _shouldFire: boolean;

	constructor() {
		super();
		this._deferredCnt = 0;
		this._shouldFire = false;
	}

	public beginDeferredEmit(): void {
		this._deferredCnt++;
	}

	public endDeferredEmit(): void {
		this._deferredCnt--;
		if (this._deferredCnt === 0) {
			if (this._shouldFire) {
				this._shouldFire = false;
				this._actual.fire({});
			}
		}
	}

	public fire(): void {
		this._shouldFire = true;
	}
}
