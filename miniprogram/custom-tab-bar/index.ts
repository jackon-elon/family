declare function Component(options: any): void;

const TABS = [
  { path: '/pages/circles/index', label: '亲友录' },
  { path: '/pages/my/index', label: '我的' }
];

Component({
  data: { tabs: TABS, selected: 0 },
  lifetimes: { attached(this: any) { this.syncSelection(); } },
  pageLifetimes: { show(this: any) { this.syncSelection(); } },
  methods: {
    syncSelection(this: any) {
      const pages = getCurrentPages();
      const route = pages[pages.length - 1]?.route || '';
      const selected = TABS.findIndex(tab => tab.path === `/${route}`);
      if (selected >= 0) this.setData({ selected });
    },
    onSwitch(this: any, event: any) {
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !TABS[index] || this.switching || index === this.data.selected) return;
      this.switching = true;
      wx.switchTab({
        url: TABS[index].path,
        success: () => this.setData({ selected: index }),
        fail: () => wx.showToast({ title: '暂时无法切换，请再试一次', icon: 'none' }),
        complete: () => { this.switching = false; }
      });
    }
  }
});
