const test = require('node:test');
const assert = require('node:assert/strict');
const {BirthdayCalendar} = require('../dist/birthday.js');

test('阳历 2 月 29 日在平年按 2 月 28 日提醒', () => {
  const calendar = new BirthdayCalendar(Date.UTC(2026, 1, 27, 12), 3, false);
  assert.deepEqual(calendar.next({calendar:'solar', month:2, day:29}),
    {date:'2026-02-28', daysUntil:1, birthdayText:'阳历2月29日'});
});

test('农历春节跨年换算，闰六月与普通六月分开', () => {
  const newYear = new BirthdayCalendar(Date.UTC(2026, 1, 16, 12), 3, true);
  assert.deepEqual(newYear.next({calendar:'lunar', month:1, day:1}),
    {date:'2026-02-17', daysUntil:1, birthdayText:'农历1月1日'});
  const leap = new BirthdayCalendar(Date.UTC(2025, 5, 1, 12), 100, true);
  assert.deepEqual(leap.next({calendar:'lunar', month:6, day:1, leapMonth:true}),
    {date:'2025-07-25', daysUntil:54, birthdayText:'农历闰6月1日'});
  assert.deepEqual(leap.next({calendar:'lunar', month:6, day:1}),
    {date:'2025-06-25', daysUntil:24, birthdayText:'农历6月1日'});
});

test('同一农历生日每年重新换算对应的阳历日期', () => {
  const birthday = {calendar:'lunar', month:1, day:1};
  const in2026 = new BirthdayCalendar(Date.UTC(2026, 1, 16, 12), 3, true).next(birthday);
  const in2027 = new BirthdayCalendar(Date.UTC(2027, 1, 5, 12), 3, true).next(birthday);
  assert.equal(in2026?.date, '2026-02-17');
  assert.equal(in2027?.date, '2027-02-06');
  assert.equal(in2026?.birthdayText, '农历1月1日');
  assert.equal(in2027?.birthdayText, '农历1月1日');
  assert.equal(new BirthdayCalendar(Date.UTC(2027,1,5,17),0,true).next(birthday)?.daysUntil,0,
    '北京时间已到 2 月 6 日时，应按今天提醒');
});

test('没有相应闰月的年份按普通同月提醒，农历短月三十按二十九提醒', () => {
  const calendar = new BirthdayCalendar(Date.UTC(2026, 0, 1, 12), 366, true);
  assert.deepEqual(calendar.next({calendar:'lunar', month:6, day:1, leapMonth:true}),
    {date:'2026-07-14', daysUntil:194, birthdayText:'农历闰6月1日'});
  const shortMonth = new BirthdayCalendar(Date.UTC(2025, 0, 1, 12), 366, true);
  assert.deepEqual(shortMonth.next({calendar:'lunar', month:2, day:30}),
    {date:'2025-03-28', daysUntil:86, birthdayText:'农历2月30日'});
});
