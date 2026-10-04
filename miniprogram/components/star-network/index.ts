import { buildStarLayout, StarPerson, StarRelation } from './layout';

declare function Component(options: any): void;

function boardStyle(width: number, height: number, left: number, top: number): string {
  return `width:${width}rpx;height:${height}rpx;left:${-left}rpx;top:${-top}rpx;`;
}

function clamp(value: number, max: number): number { return Math.max(0, Math.min(max, value)); }

Component({
  properties: {
    persons: { type: Array, value: [] },
    relations: { type: Array, value: [] },
    focusId: { type: String, value: '' },
    selfId: { type: String, value: '' },
    selectedId: { type: String, value: '' },
    relationLabels: { type: Object, value: {} }
  },
  data: {
    nodes: [] as ReturnType<typeof buildStarLayout>['nodes'],
    edges: [] as ReturnType<typeof buildStarLayout>['edges'],
    bands: [] as ReturnType<typeof buildStarLayout>['bands'],
    hiddenCount: 0,
    boardWidth: 730,
    boardHeight: 730,
    viewportHeight: 730,
    boardStyle: 'width:730rpx;height:730rpx;left:0;top:0;',
    scrollLeft: 0,
    scrollTop: 0
  },
  lifetimes: {
    attached(this: any) { this.relayout(); }
  },
  observers: {
    'persons,relations,focusId,selfId,selectedId,relationLabels': function (this: any) {
      this.relayout();
    }
  },
  methods: {
    relayout(this: any) {
      const layoutSignature = JSON.stringify({
        people: (this.properties.persons || []).map((person: StarPerson) => person.id),
        relations: (this.properties.relations || []).map((relation: StarRelation) => relation.id),
        focusId: this.properties.focusId || '',
        selfId: this.properties.selfId || ''
      });
      const shouldCenter = this.centeredLayout !== layoutSignature;
      this.centeredLayout = layoutSignature;
      const graph = buildStarLayout(
        (this.properties.persons || []) as StarPerson[],
        (this.properties.relations || []) as StarRelation[],
        this.properties.focusId || '',
        this.properties.selfId || '',
        this.properties.relationLabels || {},
        this.properties.selectedId || ''
      );
      let pxPerRpx = 0.5;
      try {
        const width = wx.getSystemInfoSync().windowWidth;
        if (Number.isFinite(width) && width > 0) pxPerRpx = width / 750;
      } catch (_) { /* layout remains usable in tests */ }
      const viewportWidth = 690;
      const viewportHeight = Math.min(graph.height, 860);
      const anchor = graph.nodes.find(node => node.isSelf) || graph.nodes.find(node => node.isFocus) || graph.nodes[0];
      const targetLeft = graph.width <= 1100
        ? (graph.width - viewportWidth) / 2
        : (anchor?.x || 0) - viewportWidth / 2;
      const maxLeft = Math.max(0, graph.width - viewportWidth);
      const maxTop = Math.max(0, graph.height - viewportHeight);
      const scrollLeftRpx = clamp(targetLeft, maxLeft);
      const scrollTopRpx = clamp((anchor?.y || 0) - viewportHeight / 2, maxTop);
      this.panBounds = { maxLeft, maxTop };
      this.panPxPerRpx = pxPerRpx;
      this.panOffset = shouldCenter || !this.panOffset
        ? { left: scrollLeftRpx, top: scrollTopRpx }
        : { left: clamp(this.panOffset.left, maxLeft), top: clamp(this.panOffset.top, maxTop) };
      const nextData: any = {
        nodes: graph.nodes,
        edges: graph.edges,
        bands: graph.bands,
        hiddenCount: graph.hiddenCount,
        boardWidth: graph.width,
        boardHeight: graph.height,
        viewportHeight,
        boardStyle: boardStyle(graph.width, graph.height, this.panOffset.left, this.panOffset.top)
      };
      // Selecting a star only changes its highlight. Keep the hand-dragged
      // position instead of snapping the graph back to the self node.
      if (shouldCenter) {
        nextData.scrollLeft = scrollLeftRpx * pxPerRpx;
        nextData.scrollTop = scrollTopRpx * pxPerRpx;
      }
      this.setData(nextData);
    },
    onPanStart(this: any, event: any) {
      const touch = event.touches?.[0];
      if (!touch) return;
      this.lastDragAt = 0;
      this.panStart = {
        x: touch.clientX,
        y: touch.clientY,
        left: this.panOffset?.left || 0,
        top: this.panOffset?.top || 0
      };
    },
    onPanMove(this: any, event: any) {
      const touch = event.touches?.[0];
      const start = this.panStart;
      if (!touch || !start) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) this.lastDragAt = Date.now();
      const left = clamp(start.left - dx / this.panPxPerRpx, this.panBounds.maxLeft);
      const top = clamp(start.top - dy / this.panPxPerRpx, this.panBounds.maxTop);
      if (Math.abs(left - this.panOffset.left) < 1 && Math.abs(top - this.panOffset.top) < 1) return;
      this.panOffset = { left, top };
      this.setData({ boardStyle: boardStyle(this.data.boardWidth, this.data.boardHeight, left, top) });
    },
    onPanEnd(this: any) { this.panStart = null; },
    onBackground(this: any) {
      if (this.lastDragAt && Date.now() - this.lastDragAt < 180) return;
      this.triggerEvent('clear');
    },
    onPerson(this: any, event: any) {
      if (this.lastDragAt && Date.now() - this.lastDragAt < 180) return;
      const personId = event.currentTarget.dataset.id;
      if (personId) this.triggerEvent('person', { personId, clientY: event.changedTouches?.[0]?.clientY ?? event.detail?.y });
    }
  }
});
