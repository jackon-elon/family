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
    orbits: [] as ReturnType<typeof buildStarLayout>['orbits'],
    hiddenCount: 0,
    boardSize: 730,
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
      this.setData({
        nodes: graph.nodes,
        edges: graph.edges,
        orbits: graph.orbits,
        hiddenCount: graph.hiddenCount,
        boardSize: graph.size,
        boardStyle: `width:${graph.size}rpx;height:${graph.size}rpx;`,
        scrollLeft: Math.max(0, (graph.size - 690) / 2) * pxPerRpx,
        scrollTop: Math.max(0, (graph.size - 690) / 2) * pxPerRpx
      });
    },
    onPerson(this: any, event: any) {
      const personId = event.currentTarget.dataset.id;
      if (personId) this.triggerEvent('person', { personId });
    }
  }
});
