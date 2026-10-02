import { buildStarLayout, StarPerson, StarRelation } from './layout';

declare function Component(options: any): void;

Component({
  properties: {
    persons: { type: Array, value: [] },
    relations: { type: Array, value: [] },
    focusId: { type: String, value: '' },
    selfId: { type: String, value: '' },
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
    boardStyle: 'width:730rpx;height:730rpx;',
    scrollLeft: 0,
    scrollTop: 0
  },
  lifetimes: {
    attached(this: any) { this.relayout(); }
  },
  observers: {
    'persons,relations,focusId,selfId,relationLabels': function (this: any) {
      this.relayout();
    }
  },
  methods: {
    relayout(this: any) {
      const graph = buildStarLayout(
        (this.properties.persons || []) as StarPerson[],
        (this.properties.relations || []) as StarRelation[],
        this.properties.focusId || '',
        this.properties.selfId || '',
        this.properties.relationLabels || {}
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
      const scrollLeftRpx = Math.max(0, Math.min(graph.width - viewportWidth, targetLeft));
      const scrollTopRpx = Math.max(0, Math.min(graph.height - viewportHeight, (anchor?.y || 0) - viewportHeight / 2));
      this.setData({
        nodes: graph.nodes,
        edges: graph.edges,
        bands: graph.bands,
        hiddenCount: graph.hiddenCount,
        boardWidth: graph.width,
        boardHeight: graph.height,
        viewportHeight,
        boardStyle: `width:${graph.width}rpx;height:${graph.height}rpx;`,
        scrollLeft: scrollLeftRpx * pxPerRpx,
        scrollTop: scrollTopRpx * pxPerRpx
      });
    },
    onPerson(this: any, event: any) {
      const personId = event.currentTarget.dataset.id;
      if (personId) this.triggerEvent('person', { personId });
    }
  }
});
