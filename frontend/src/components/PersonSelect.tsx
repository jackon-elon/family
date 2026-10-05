import { useId, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { PersonView } from "../types";
import { matchesPerson } from "../shared/person-search";
import { Avatar } from "./UI";

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
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = people.find(
    (person) => person.id === value && person.id !== excludeId,
  );
  const candidates = people.filter((person) => person.id !== excludeId);
  const matches = candidates.filter((person) => matchesPerson(person, query));
  const duplicateNames = new Set(
    candidates
      .filter(
        (person, index) =>
          candidates.findIndex((other) => other.name === person.name) !== index,
      )
      .map((person) => person.name),
  );
  const description = (person: PersonView) =>
    [
      person.city,
      duplicateNames.has(person.name)
        ? person.phone
          ? `尾号${person.phone.slice(-4)}`
          : "号码未填"
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const close = () => {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };
  return (
    <div
      className="person-select"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <span id={`${id}-label`} className="person-picker-label">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className="person-picker-trigger"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
      >
        {selected && <Avatar person={selected} />}
        <span id={`${id}-value`} className="person-picker-copy">
          <strong>{selected?.name || "点这里选择家人"}</strong>
          {selected && <small>{description(selected)}</small>}
        </span>
        {selected && <span className="person-picker-change">更换</span>}
        <ChevronDown size={20} aria-hidden="true" />
      </button>
      {open && (
        <div id={`${id}-panel`} className="person-picker-panel">
          <input
            type="search"
            aria-label="搜索家人"
            placeholder="输入姓名，也可直接点下面的家人"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          <div
            className="person-picker-results"
            aria-label="可选择的家人"
            role="group"
          >
            {matches.map((person) => (
              <button
                key={person.id}
                type="button"
                className="person-picker-option"
                aria-pressed={person.id === value}
                onClick={() => {
                  if (person.id !== value) onChange(person.id);
                  close();
                }}
              >
                <Avatar person={person} />
                <span className="person-picker-copy">
                  <strong>{person.name}</strong>
                  <small>{description(person)}</small>
                </span>
                {person.id === value && <Check size={20} aria-hidden="true" />}
              </button>
            ))}
            {!matches.length && (
              <p className="hint" role="status">
                {candidates.length
                  ? "没找到这位家人，换个姓名试试。"
                  : "还没有其他家人，请先添加家人资料。"}
              </p>
            )}
          </div>
          <button
            type="button"
            className="button full person-picker-cancel"
            onClick={close}
          >
            取消选择
          </button>
        </div>
      )}
    </div>
  );
}
