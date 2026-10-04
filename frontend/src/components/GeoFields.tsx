import { useMemo, useState } from "react";
import {
  cityChoices,
  cityCountries,
  cityOptionInProvince,
  cityProvinces,
  catalogProvince,
  type GeoValue,
} from "../shared/geography";
import "./visuals.css";

interface Props {
  value: GeoValue;
  onChange(value: GeoValue): void;
  disabled?: boolean;
}
const MANUAL = "__manual_city__";

export default function GeoFields({
  value,
  onChange,
  disabled = false,
}: Props) {
  const countries = useMemo(cityCountries, []);
  const provinces = useMemo(
    () => cityProvinces(value.country || ""),
    [value.country],
  );
  const cities = useMemo(
    () => cityChoices(value.country || "", value.province || ""),
    [value.country, value.province],
  );
  const [manualCity, setManualCity] = useState(false);
  const [manualCountry, setManualCountry] = useState(false);
  const [manualProvince, setManualProvince] = useState(false);
  const knownCity = cityOptionInProvince(
    value.city,
    value.country,
    value.province,
  );
  const knownProvince = catalogProvince(value.country, value.province);
  const unknownCountry = !!value.country && !countries.includes(value.country);
  const unknownProvince =
    !!value.province && !provinces.includes(knownProvince);
  const unknownCity =
    !!value.city &&
    !cities.some((option) => option.city === (knownCity?.city || value.city));
  const customCountry = manualCountry || unknownCountry;
  const customProvince = manualProvince || unknownProvince;
  const customCity = manualCity || unknownCity;
  const update = (patch: GeoValue) =>
    onChange({ ...value, latitude: undefined, longitude: undefined, ...patch });

  return (
    <fieldset className="geo-fields" disabled={disabled}>
      <legend>所在城市</legend>
      <div className="geo-fields-grid">
        <label>
          国家 / 地区
          <select
            aria-label="国家 / 地区"
            value={customCountry ? MANUAL : value.country || ""}
            onChange={(event) => {
              const country = event.target.value;
              setManualCountry(country === MANUAL);
              setManualProvince(false);
              setManualCity(false);
              update({
                country: country === MANUAL ? "" : country,
                province: "",
                city: "",
              });
            }}
          >
            <option value="">请选择</option>
            {countries.map((country) => (
              <option key={country}>{country}</option>
            ))}
            <option value={MANUAL}>其他，手动填写</option>
          </select>
          {customCountry && (
            <input
              aria-label="填写国家或地区"
              value={value.country || ""}
              maxLength={80}
              placeholder="填写国家或地区"
              onChange={(event) =>
                update({ country: event.target.value, province: "", city: "" })
              }
            />
          )}
        </label>
        <label>
          省 / 州
          <select
            aria-label="省 / 州"
            disabled={disabled || !value.country}
            value={customProvince ? MANUAL : knownProvince}
            onChange={(event) => {
              const province = event.target.value;
              setManualProvince(province === MANUAL);
              setManualCity(false);
              update({
                province: province === MANUAL ? "" : province,
                city: "",
              });
            }}
          >
            <option value="">请选择</option>
            {provinces.map((province) => (
              <option key={province} value={province}>
                {province || "不分省 / 州"}
              </option>
            ))}
            <option value={MANUAL}>其他，手动填写</option>
          </select>
          {customProvince && (
            <input
              aria-label="填写省或州"
              value={value.province || ""}
              maxLength={80}
              placeholder="填写省或州（可不填）"
              onChange={(event) =>
                update({ province: event.target.value, city: "" })
              }
            />
          )}
        </label>
        <label>
          城市
          <select
            aria-label="城市"
            disabled={disabled || !value.country}
            value={customCity ? MANUAL : knownCity?.city || value.city || ""}
            onChange={(event) => {
              const city = event.target.value;
              setManualCity(city === MANUAL);
              const match = cities.find((option) => option.city === city);
              update(match || { city: "" });
            }}
          >
            <option value="">请选择</option>
            {cities.map((city) => (
              <option key={city.city}>{city.city}</option>
            ))}
            <option value={MANUAL}>找不到城市，手动填写</option>
          </select>
          {customCity && (
            <input
              aria-label="填写城市"
              value={value.city || ""}
              maxLength={80}
              placeholder="填写城市名称"
              onChange={(event) => {
                const city = event.target.value;
                const match = cityOptionInProvince(
                  city,
                  value.country,
                  value.province,
                );
                update(match || { city });
              }}
            />
          )}
        </label>
      </div>
      <p className="visual-note">
        仅记录城市，不记录住址。
        {customCity &&
        !cityOptionInProvince(value.city, value.country, value.province)
          ? "手填城市会保留在名单中，匹配到坐标后再显示地图标记。"
          : "地图标记位于城市中心。"}
      </p>
    </fieldset>
  );
}
