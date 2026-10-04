import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import GeoFields from "./GeoFields";
import { Alert } from "./UI";
import type { Birthday, PersonView, UserProfile } from "../types";
import { errorText, preparePhoto } from "../api";
import { gregorianForLunar } from "../shared/lunar-calendar";

export interface ProfileDraft {
  name: string;
  nickname: string;
  gender: "male" | "female" | "unknown";
  country?: string;
  province?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  calendar: "solar" | "lunar";
  year: string;
  month: string;
  day: string;
  leapMonth: boolean;
  phone: string;
  wechatId: string;
  status: string;
  school: string;
  industry: string;
  occupation: string;
  bio: string;
}
export function draftOf(
  p?: Partial<PersonView | UserProfile> | null,
): ProfileDraft {
  return {
    name: p?.name || "",
    nickname: p?.nickname || "",
    gender: p?.gender || "unknown",
    country: p?.country || "中国",
    province: p?.province,
    city: p?.city,
    latitude: p?.latitude,
    longitude: p?.longitude,
    calendar: p?.birthday?.calendar || "solar",
    year: String(p?.birthday?.year || ""),
    month: String(p?.birthday?.month || ""),
    day: String(p?.birthday?.day || ""),
    leapMonth: !!p?.birthday?.leapMonth,
    phone: p?.phone || "",
    wechatId: p?.wechatId || "",
    status: p?.status || "",
    school: p?.school || "",
    industry: p?.industry || "",
    occupation: p?.occupation || "",
    bio: p?.bio || "",
  };
}
export function profilePhone(value: string): string {
  if (value.length > 30)
    throw new Error("请填写有效手机号；海外号码请带国家区号。");
  let phone = value.replace(/[\s()-]/g, "");
  if (/^1[3-9]\d{9}$/.test(phone)) phone = `+86${phone}`;
  if (
    !/^\+[1-9]\d{7,14}$/.test(phone) ||
    (phone.startsWith("+86") && !/^\+861[3-9]\d{9}$/.test(phone))
  )
    throw new Error("请填写有效手机号；海外号码请带国家区号。");
  return phone;
}
export function patchOf(
  d: ProfileDraft,
  options: { requirePhone?: boolean } = {},
) {
  if (
    !d.name.trim() ||
    !d.country?.trim() ||
    !d.city?.trim() ||
    !d.month ||
    !d.day
  )
    throw new Error("请填好姓名、所在城市和生日。");
  const birthday: Birthday = {
    calendar: d.calendar,
    month: Number(d.month),
    day: Number(d.day),
    ...(d.year ? { year: Number(d.year) } : {}),
    ...(d.calendar === "lunar" && d.leapMonth ? { leapMonth: true } : {}),
  };
  if (
    birthday.year !== undefined &&
    (!Number.isInteger(birthday.year) ||
      birthday.year < 1900 ||
      birthday.year > new Date().getFullYear())
  )
    throw new Error("请填写有效的出生年份，或留空。");
  if (
    !Number.isInteger(birthday.month) ||
    birthday.month < 1 ||
    birthday.month > 12 ||
    !Number.isInteger(birthday.day) ||
    birthday.day < 1 ||
    birthday.day > birthdayDaysInMonth(d)
  )
    throw new Error("生日日期不存在，请重新选择月份和日期。");
  // The published table fully covers lunar years 1901–2099. A missing
  // result in that range means an impossible date, not a missing table row.
  if (
    birthday.calendar === "lunar" &&
    birthday.year &&
    birthday.year >= 1901 &&
    birthday.year <= 2099 &&
    !gregorianForLunar({
      year: birthday.year,
      month: birthday.month,
      day: birthday.day,
      leapMonth: !!birthday.leapMonth,
    })
  )
    throw new Error("这一年的农历生日不存在，请核对月份、日期和闰月。");
  return {
    name: d.name.trim(),
    nickname: d.nickname || null,
    gender: d.gender,
    country: d.country.trim(),
    province: d.province || null,
    city: d.city.trim(),
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    birthday,
    phone: options.requirePhone
      ? profilePhone(d.phone)
      : d.phone.trim() || null,
    wechatId: d.wechatId || null,
    status: d.status || null,
    school: d.school || null,
    industry: d.industry || null,
    occupation: d.occupation || null,
    bio: d.bio || null,
  };
}
export function birthdayDaysInMonth(draft: ProfileDraft): number {
  if (draft.calendar === "lunar") {
    const year = Number(draft.year),
      month = Number(draft.month);
    if (
      Number.isInteger(year) &&
      year >= 1901 &&
      year <= 2099 &&
      month >= 1 &&
      month <= 12
    ) {
      const lunar = { year, month, day: 1, leapMonth: draft.leapMonth };
      if (gregorianForLunar(lunar))
        return gregorianForLunar({ ...lunar, day: 30 }) ? 30 : 29;
    }
    return 30;
  }
  return draft.month
    ? new Date(
        Date.UTC(Number(draft.year) || 2000, Number(draft.month), 0),
      ).getUTCDate()
    : 31;
}
export function createFields(d: ProfileDraft) {
  const p = patchOf(d, { requirePhone: true });
  return {
    name: p.name,
    nickname: p.nickname || undefined,
    gender: p.gender,
    country: p.country,
    province: p.province || undefined,
    city: p.city,
    latitude: p.latitude ?? undefined,
    longitude: p.longitude ?? undefined,
    birthday: p.birthday,
    phone: p.phone,
  };
}
export default function ProfileForm({
  value,
  onChange,
  disabled = false,
  onPhoto,
  photoUrl,
  photoBase64,
  onPhotoPreparing,
  phoneRequired = false,
}: {
  value: ProfileDraft;
  onChange: (value: ProfileDraft) => void;
  disabled?: boolean;
  onPhoto?: (base64: string) => void;
  photoUrl?: string;
  photoBase64?: string;
  onPhotoPreparing?: (preparing: boolean) => void;
  phoneRequired?: boolean;
}) {
  const [photoError, setPhotoError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      onPhotoPreparing?.(false);
    },
    [onPhotoPreparing],
  );
  const set = <K extends keyof ProfileDraft>(key: K, next: ProfileDraft[K]) =>
    onChange({ ...value, [key]: next });
  const setBirthday = (change: Partial<ProfileDraft>) => {
    const next = { ...value, ...change };
    if (Number(next.day) > birthdayDaysInMonth(next)) next.day = "";
    onChange(next);
  };
  const text = (
    key: keyof ProfileDraft,
    label: string,
    placeholder = "",
    required = false,
  ) => (
    <label>
      {label}
      {required && <span className="required"> *</span>}
      <input
        value={String(value[key] || "")}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={key === "name" || key === "nickname" ? 60 : 120}
        onChange={(e) => set(key, e.target.value as never)}
      />
    </label>
  );
  return (
    <fieldset className="profile-fields" disabled={disabled}>
      <div className="photo-field">
        <div className="avatar large">
          {photoBase64 || photoUrl ? (
            <img
              alt="个人照片"
              src={
                photoBase64 ? `data:image/jpeg;base64,${photoBase64}` : photoUrl
              }
            />
          ) : (
            value.name?.slice(-2) || <Camera size={26} />
          )}
        </div>
        {onPhoto && (
          <label className="button secondary upload-button">
            {preparing ? "正在处理…" : "选择照片"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={disabled || preparing}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const version = ++generation.current;
                setPhotoError("");
                setPreparing(true);
                onPhotoPreparing?.(true);
                try {
                  const photo = await preparePhoto(file);
                  if (version === generation.current) onPhoto(photo);
                } catch (err) {
                  if (version === generation.current)
                    setPhotoError(errorText(err));
                } finally {
                  if (version === generation.current) {
                    setPreparing(false);
                    onPhotoPreparing?.(false);
                  }
                  e.target.value = "";
                }
              }}
            />
          </label>
        )}
        <span className="hint">留下熟悉的面孔</span>
      </div>
      <Alert message={photoError} />
      <div className="form-grid">
        {text("name", "姓名", "真实姓名", true)}
        {text("nickname", "昵称", "选填")}
        <label>
          性别
          <select
            value={value.gender}
            onChange={(e) =>
              set("gender", e.target.value as ProfileDraft["gender"])
            }
          >
            <option value="unknown">暂不填写</option>
            <option value="male">男</option>
            <option value="female">女</option>
          </select>
        </label>
      </div>
      {phoneRequired && (
        <label>
          手机号 <span className="required">*</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={value.phone}
            maxLength={30}
            placeholder="国内手机号或带国家区号的海外号码"
            onChange={(e) => set("phone", e.target.value)}
          />
          <span className="hint">
            用于与本人登录账号对应，受邀加入后由管理员确认。
          </span>
        </label>
      )}
      <div className="field-section">
        <h3>
          所在城市 <span className="required">*</span>
        </h3>
        <GeoFields
          value={value}
          onChange={(geo) => onChange({ ...value, ...geo })}
          disabled={disabled}
        />
        <p className="hint">地图只显示城市位置。</p>
      </div>
      <div className="field-section">
        <h3>
          生日 <span className="required">*</span>
        </h3>
        <div className="birthday-fields">
          <label>
            历法
            <select
              value={value.calendar}
              onChange={(e) =>
                setBirthday({
                  calendar: e.target.value as "solar" | "lunar",
                  leapMonth: false,
                })
              }
            >
              <option value="solar">阳历</option>
              <option value="lunar">农历</option>
            </select>
          </label>
          <label>
            年份 · 选填
            <input
              inputMode="numeric"
              type="number"
              min="1900"
              max={new Date().getFullYear()}
              placeholder="出生年份"
              value={value.year}
              onChange={(e) => setBirthday({ year: e.target.value })}
            />
          </label>
          <label>
            月
            <select
              required
              value={value.month}
              onChange={(e) => setBirthday({ month: e.target.value })}
            >
              <option value="">选择</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1} 月
                </option>
              ))}
            </select>
          </label>
          <label>
            日
            <select
              required
              value={value.day}
              onChange={(e) => set("day", e.target.value)}
            >
              <option value="">选择</option>
              {Array.from({ length: birthdayDaysInMonth(value) }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1} 日
                </option>
              ))}
            </select>
          </label>
        </div>
        {value.calendar === "lunar" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={value.leapMonth}
              onChange={(e) => setBirthday({ leapMonth: e.target.checked })}
            />
            出生在农历闰月
          </label>
        )}
        <p className="hint">
          农历生日会自动换算成每年的阳历日期；填写年份后可判断家人的长幼。
        </p>
      </div>
      <details className="form-details">
        <summary>
          联系方式与近况 <span>选填</span>
        </summary>
        <div className="form-grid">
          {!phoneRequired && text("phone", "联系电话")}
          {text("wechatId", "微信号")}
          {text("status", "目前在做什么", "例如：上学、工作、退休")}
          {text("school", "学校")}
          {text("industry", "行业")}
          {text("occupation", "职业")}
        </div>
        <label>
          近况
          <textarea
            rows={3}
            maxLength={500}
            value={value.bio}
            onChange={(e) => set("bio", e.target.value)}
            placeholder="想和家人分享的近况"
          />
        </label>
      </details>
    </fieldset>
  );
}
