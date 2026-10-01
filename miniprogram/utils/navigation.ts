export function q(value: string): string { return encodeURIComponent(value); }
export function go(path: string): void { wx.navigateTo({ url: path }); }
export function toast(message: string): void { wx.showToast({ title: message, icon: 'none', duration: 2300 }); }
export function confirm(title: string, content: string): Promise<boolean> {
  return new Promise(resolve => wx.showModal({ title, content, confirmColor: '#1d684e', success: (r: any) => resolve(!!r.confirm), fail: () => resolve(false) }));
}
export function dateText(epoch?: number): string {
  if (!epoch) return '未记录';
  const d = new Date(epoch);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
