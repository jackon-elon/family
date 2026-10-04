import { invoke } from '../../services/api';
import { go, q } from '../../utils/navigation';
import { BirthdayEvent, BirthdayRow, birthdayRows } from './model';

Page({
  data: { rows: [] as BirthdayRow[], loading: true, error: '' },
  onShow(this: any) { return this.loadData(); },
  onUnload(this: any) { this.loadVersion = (this.loadVersion || 0) + 1; },
  onPullDownRefresh(this: any) { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData(this: any) {
    const loadVersion = (this.loadVersion || 0) + 1;
    this.loadVersion = loadVersion;
    this.setData({ loading: true, error: '' });
    const session = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (this.loadVersion !== loadVersion) return;
    if (!session.ok) { this.setData({rows: [], loading: false, error: session.error.message}); return; }
    if (!session.data.hasVerifiedPhone) { wx.reLaunch({url: `/pages/login/index?next=${q('/pages/events/index')}`}); return; }
    const result = await invoke<{ events: BirthdayEvent[] }>({ action: 'birthday.upcoming', payload: { days: 366 } });
    if (this.loadVersion !== loadVersion) return;
    if (!result.ok) { this.setData({ rows: [], loading: false, error: result.error.message }); return; }
    this.setData({ rows: birthdayRows(result.data.events), loading: false });
  },
  onRetry(this: any) { if (!this.data.loading) this.loadData(); },
  onPerson(this: any, event: any) {
    const row = this.data.rows.find((item: BirthdayRow) => item.personId === event.currentTarget.dataset.personId && item.circleId === event.currentTarget.dataset.circleId);
    if (row) go(`/pages/person/index?circleId=${q(row.circleId)}&personId=${q(row.personId)}`);
  }
});
