import type { DesignAnalysisResult, EditableObject, XY, Destination } from '../core/types.js';
export type EditorTool = 'select' | 'place' | 'polygon' | 'entrance' | 'relocate';
export interface EditHandle {
  id: string;
  part: 'object' | 'vertex' | 'entrance';
  index: number;
}
export interface EditorDrag extends EditHandle {
  point: XY;
  phase: 'start' | 'move' | 'end' | 'cancel';
}
export interface EditorView {
  active: boolean;
  tool: EditorTool;
  kind: Destination['kind'];
  selectedId: string | null;
  draft: EditableObject | null;
  polygon: XY[];
  overlay: DesignAnalysisResult | null;
}
export const EMPTY_EDITOR: EditorView = {
  active: false,
  tool: 'select',
  kind: 'bus_stop',
  selectedId: null,
  draft: null,
  polygon: [],
  overlay: null,
};
export interface EditorEvents {
  point: (point: XY) => void;
  drag: (event: EditorDrag) => void;
  cancel: () => void;
}
