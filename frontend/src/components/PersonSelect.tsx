import { useState } from "react";
import type { PersonView } from "../types";

// Keep the native select usable on phones, with a search for larger families.
export default function PersonSelect({
  people,
  label,
  value,
  onChange,
  excludeId,
}: {
  people: PersonView[];
  label: string;
  value: string;
  onChange: (id: string) => void;
  excludeId?: string;
}) {
  const [query, setQuery] = useState("");
  const matches = people.filter(
    (person) =>
      person.id === value ||
      [person.name, person.nickname, person.city, person.phone].some((text) =>
        text?.includes(query.trim()),
      ),
  );
  const duplicates = new Set(
    people
      .filter(
        (person, index) =>
          people.findIndex((p) => p.name === person.name) !== index,
      )
      .map((person) => person.name),
  );
  return (
    <div className="person-select">
      {people.length > 12 && (
        <label>
          查找{label}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入姓名、城市或手机号"
          />
        </label>
      )}
      <label>
        {label}
        <select
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">选择家人</option>
          {matches.map((person) => (
            <option
              key={person.id}
              value={person.id}
              disabled={person.id === excludeId}
            >
              {person.name}
              {person.city ? ` · ${person.city}` : ""}
              {duplicates.has(person.name)
                ? ` · ${person.phone ? `尾号${person.phone.slice(-4)}` : "号码未填"}`
                : ""}
            </option>
          ))}
        </select>
      </label>
      {!matches.length && (
        <p className="hint">没有匹配的家人，换个姓名或城市试试。</p>
      )}
    </div>
  );
}
