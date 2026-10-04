import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  ChevronDown,
  Globe2,
  MapPin,
  RotateCw,
  Users,
  X,
  Expand,
  Shrink,
} from "lucide-react";
import {
  citySummary,
  type CityGroup,
  type MapPerson,
} from "../shared/geography";
import { clusterCityMarkers } from "../shared/map-clusters";
import { createMapCanvas } from "../shared/map-canvas";
import {
  visibleBasemapLabels,
  cityFocusZoom,
  type BasemapLabel,
} from "../shared/basemap-labels";
import worldMap from "../assets/basemap/world.json";
import worldLabels from "../assets/basemap/labels.json";
import chinaProvinces from "../assets/basemap/china-provinces.json";
import cityLabels from "../assets/basemap/city-labels.json";
import cityDataLicenseUrl from "../assets/basemap/china-cities-LICENSE.txt?url&no-inline";
import type { GeoJsonObject } from "geojson";
import "leaflet/dist/leaflet.css";
import "./visuals.css";

interface Props {
  people: MapPerson[];
  onSelect(id: string, anchor?: HTMLElement): void;
  labels?: Record<string, string>;
}
type Scope = "china" | "world";
type MapStatus = "loading" | "ready" | "error";
const MAX_MAP_ZOOM = 9;
const PROVINCE_ZOOM = 2;
const LOCAL_ATTRIBUTION =
  '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a> · <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a>';
const OVERVIEW_LABELS: BasemapLabel[] = [
  { name: "亚洲", latitude: 42, longitude: 94 },
  { name: "欧洲", latitude: 54, longitude: 20 },
  { name: "非洲", latitude: 4, longitude: 20 },
  { name: "北美洲", latitude: 43, longitude: -105 },
  { name: "南美洲", latitude: -17, longitude: -61 },
  { name: "大洋洲", latitude: -24, longitude: 135 },
  { name: "太平洋", latitude: 1, longitude: -146, kind: "ocean" },
  { name: "大西洋", latitude: 12, longitude: -35, kind: "ocean" },
].map((label) => ({ ...label, minZoom: -1, maxZoom: 1.75 })) as BasemapLabel[];
const BASEMAP_LABELS = [
  ...OVERVIEW_LABELS,
  ...worldLabels,
  ...cityLabels,
] as BasemapLabel[];
const DETAILED_COUNTRIES = new Set(
  chinaProvinces.features.map((feature) => feature.properties.countryId),
);

export default function PersonMap({ people, onSelect, labels = {} }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const overview = useRef(true);
  const [expanded, setExpanded] = useState(false);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scope, setScope] = useState<Scope>("china");
  const [selectedKey, setSelectedKey] = useState("");
  const [clusterKeys, setClusterKeys] = useState<string[]>([]);
  const [status, setStatus] = useState<MapStatus>("ready");
  const [reload, setReload] = useState(0);
  const summary = useMemo(() => citySummary(people), [people]);
  const selected = summary.groups.find((group) => group.key === selectedKey);
  const selectedCluster = summary.groups.filter((group) =>
    clusterKeys.includes(group.key),
  );
  const selectedHandler = useRef<(group: CityGroup) => void>(() => {});
  const mapGroups = useRef(summary.groups),
    mapScope = useRef(scope);
  mapGroups.current = summary.groups;
  mapScope.current = scope;
  const redrawNames = useRef<() => void>(() => {});

  const frameScope = (view: Scope) => {
    if (!map.current) return;
    if (view === "china")
      map.current.fitBounds(
        [
          [17, 72],
          [55, 136],
        ],
        { padding: [18, 18], animate: false },
      );
    else
      map.current.fitBounds(
        [
          [-58, -172],
          [76, 177],
        ],
        { padding: [12, 12], animate: false },
      );
    overview.current = true;
  };
  const chooseCity = (group: CityGroup) => {
    setClusterKeys([]);
    setSelectedKey((current) => (current === group.key ? "" : group.key));
    if (group.point && group.key !== selectedKey) {
      overview.current = false;
      if (group.outsideChina && scope === "china") setScope("world");
      // City-level coordinates are deliberately coarse; do not imply a home location.
      const instance = map.current;
      requestAnimationFrame(() => {
        if (map.current !== instance) return;
        instance?.setView(
          [group.point!.latitude, group.point!.longitude],
          cityFocusZoom(instance.getSize().x),
          { animate: false },
        );
      });
    }
    if (group.key !== selectedKey)
      requestAnimationFrame(() => {
        detail.current?.focus({ preventScroll: true });
        detail.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
  };
  selectedHandler.current = chooseCity;

  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, {
      zoomControl: false,
      attributionControl: true,
      minZoom: -1,
      maxZoom: MAX_MAP_ZOOM,
      zoomSnap: 0.25,
      maxBounds: [
        [-85, -180],
        [85, 180],
      ],
      maxBoundsViscosity: 1,
      preferCanvas: true,
      scrollWheelZoom: false,
      worldCopyJump: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
    });
    map.current = instance;
    // Local vectors remain beneath the optional tile layer and work without an
    // external map service. Use separate low panes so online tiles can cover it.
    const landPane = instance.createPane("localLand");
    landPane.style.zIndex = "100";
    landPane.style.pointerEvents = "none";
    const namesPane = instance.createPane("localNames");
    namesPane.style.zIndex = "150";
    namesPane.style.pointerEvents = "none";
    const landOptions: L.GeoJSONOptions & L.PathOptions = {
      pane: "localLand",
      renderer: createMapCanvas(L, { pane: "localLand" }),
      interactive: false,
      attribution: LOCAL_ATTRIBUTION,
      style: {
        color: "#bfc8bd",
        weight: 0.8,
        opacity: 1,
        fillColor: "#f4f0e5",
        fillOpacity: 1,
      },
    };
    // Replace the same source territories at regional zoom, rather than draw
    // two coastlines of different resolutions on top of each other.
    L.geoJSON(worldMap as GeoJsonObject, {
      ...landOptions,
      filter: (feature) => !DETAILED_COUNTRIES.has(feature.properties?.id),
    }).addTo(instance);
    const overviewLand = L.geoJSON(worldMap as GeoJsonObject, {
      ...landOptions,
      filter: (feature) => DETAILED_COUNTRIES.has(feature.properties?.id),
    }).addTo(instance);
    const provinceOptions: L.GeoJSONOptions & L.PathOptions = {
      ...landOptions,
      renderer: createMapCanvas(L, { pane: "localLand" }),
      style: {
        color: "#bcc6b2",
        weight: 0.85,
        opacity: 1,
        fillColor: "#f4f0e5",
        fillOpacity: 1,
      },
    };
    const provinceLand = L.geoJSON(
      chinaProvinces as GeoJsonObject,
      provinceOptions,
    );
    const geographicNames = L.layerGroup().addTo(instance);
    const drawGeographicNames = () => {
      if (instance.getZoom() >= PROVINCE_ZOOM) {
        if (instance.hasLayer(overviewLand)) overviewLand.remove();
        if (!instance.hasLayer(provinceLand)) provinceLand.addTo(instance);
      } else {
        if (instance.hasLayer(provinceLand)) provinceLand.remove();
        if (!instance.hasLayer(overviewLand)) overviewLand.addTo(instance);
      }
      geographicNames.clearLayers();
      const size = instance.getSize();
      const memberBadges = clusterCityMarkers(
        mapGroups.current.filter(
          (group) =>
            group.point &&
            (mapScope.current !== "china" || !group.outsideChina),
        ),
        (point) =>
          instance.latLngToContainerPoint([point.latitude, point.longitude]),
      ).map((marker) => ({
        x: marker.x,
        y: marker.y - 20,
        width: 122,
        height: 50,
      }));
      const visible = visibleBasemapLabels(
        BASEMAP_LABELS,
        instance.getZoom(),
        (label) =>
          instance.latLngToContainerPoint([label.latitude, label.longitude]),
        size,
        [
          ...memberBadges,
          { x: size.x - 25, y: 49, width: 52, height: 96 },
          { x: 65, y: size.y - 15, width: 130, height: 30 },
        ],
      );
      for (const label of visible) {
        const text = document.createElement("span");
        text.className = `basemap-name kind-${label.kind || "country"}`;
        text.textContent = label.name;
        L.marker([label.latitude, label.longitude], {
          pane: "localNames",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "basemap-label",
            html: text,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        }).addTo(geographicNames);
      }
    };
    redrawNames.current = drawGeographicNames;
    instance.on("moveend zoomend resize", drawGeographicNames);
    L.control
      .zoom({
        position: "topright",
        zoomInTitle: "放大地图",
        zoomOutTitle: "缩小地图",
      })
      .addTo(instance);
    L.control
      .scale({ imperial: false, maxWidth: 100, position: "bottomleft" })
      .addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    instance.on("dragstart zoomstart", () => {
      overview.current = false;
    });
    const resize = new ResizeObserver(() => {
      const wasOverview = overview.current;
      instance.invalidateSize({ animate: false });
      if (wasOverview) frameScope(mapScope.current);
    });
    resize.observe(element.current);
    frameScope("china");
    drawGeographicNames();
    return () => {
      resize.disconnect();
      clearTimeout(timeout.current);
      instance.off("moveend zoomend resize", drawGeographicNames);
      redrawNames.current = () => {};
      instance.remove();
      map.current = null;
      layer.current = null;
      tiles.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    let active = true;
    let failed = false;
    const url = import.meta.env.VITE_MAP_TILE_URL?.trim();
    if (!url) {
      setStatus("ready");
      return;
    }
    const attribution = import.meta.env.VITE_MAP_ATTRIBUTION || "";
    const tileLayer = L.tileLayer(url, {
      attribution,
      maxZoom: MAX_MAP_ZOOM,
      minZoom: 0,
      noWrap: true,
      crossOrigin: false,
    });
    const showLocalMap = () => {
      if (!active || failed) return;
      failed = true;
      clearTimeout(timeout.current);
      tileLayer.off();
      tileLayer.remove();
      setStatus("error");
    };
    const start = () => {
      if (!active || failed) return;
      setStatus("loading");
      clearTimeout(timeout.current);
      timeout.current = setTimeout(showLocalMap, 12000);
    };
    tileLayer.on("loading", start);
    tileLayer.on("tileerror", showLocalMap);
    tileLayer.on("load", () => {
      clearTimeout(timeout.current);
      if (active && !failed) setStatus("ready");
    });
    tiles.current = tileLayer;
    start();
    tileLayer.addTo(instance);
    return () => {
      active = false;
      clearTimeout(timeout.current);
      tileLayer.off();
      tileLayer.remove();
    };
  }, [reload]);

  useEffect(() => {
    const markers = layer.current;
    const instance = map.current;
    if (!markers || !instance) return;
    const drawMarkers = () => {
      markers.clearLayers();
      const visible = summary.groups.filter(
        (group) => group.point && (scope !== "china" || !group.outsideChina),
      );
      const clusters = clusterCityMarkers(visible, (point) =>
        instance.latLngToLayerPoint([point.latitude, point.longitude]),
      );
      for (const cluster of clusters) {
        const group = cluster.groups[0];
        const combined = cluster.groups.length > 1;
        // DOM text prevents a name or place from becoming executable marker markup.
        const badge = document.createElement("div");
        badge.className = `city-map-pin${combined ? " is-cluster" : ""}${!combined && group.key === selectedKey ? " is-selected" : ""}`;
        const city = document.createElement("span");
        city.textContent = combined
          ? `${cluster.groups.length} 座城市`
          : group.city;
        const count = document.createElement("strong");
        count.textContent = String(cluster.count);
        badge.append(city, count);
        const icon = L.divIcon({
          className: "city-map-marker",
          html: badge,
          iconSize: [110, 44],
          iconAnchor: [55, 49],
        });
        const title = combined
          ? `${cluster.groups.length} 座城市，共 ${cluster.count} 人，点击展开`
          : `${group.city}，${cluster.count} 人`;
        const marker = L.marker(
          instance.layerPointToLatLng([cluster.x, cluster.y]),
          {
            icon,
            keyboard: true,
            title,
            alt: title,
            riseOnHover: true,
          },
        );
        const activate = () => {
          if (!combined) {
            selectedHandler.current(group);
            return;
          }
          overview.current = false;
          setSelectedKey("");
          setClusterKeys(cluster.groups.map((city) => city.key));
          instance.fitBounds(
            cluster.groups.map(
              (city) =>
                [city.point!.latitude, city.point!.longitude] as L.LatLngTuple,
            ),
            {
              padding: [65, 60],
              maxZoom: MAX_MAP_ZOOM,
              animate: false,
            },
          );
          requestAnimationFrame(() => {
            detail.current?.focus({ preventScroll: true });
            detail.current?.scrollIntoView({
              block: "nearest",
              inline: "nearest",
            });
          });
        };
        marker.on("click", activate);
        marker.addTo(markers);
        const markerElement = marker.getElement();
        if (markerElement) {
          markerElement.setAttribute("role", "button");
          markerElement.setAttribute("aria-label", title);
          // Leaflet makes custom markers focusable but does not activate a
          // custom click handler from the keyboard unless a popup is bound.
          const activateFromKeyboard = (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) activate();
          };
          markerElement.addEventListener("keydown", activateFromKeyboard);
          marker.once("remove", () =>
            markerElement.removeEventListener("keydown", activateFromKeyboard),
          );
        }
      }
    };
    drawMarkers();
    redrawNames.current();
    instance.on("zoomend resize", drawMarkers);
    return () => {
      instance.off("zoomend resize", drawMarkers);
      markers.clearLayers();
    };
  }, [summary, scope, selectedKey]);

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey("");
  }, [selectedKey, selected]);

  return (
    <section
      ref={section}
      className={`person-map${expanded ? " is-expanded" : ""}`}
      aria-label="天南海北，看看大家在哪里"
    >
      <div className="visual-toolbar map-toolbar">
        <div className="map-scope" aria-label="地图范围">
          <button
            type="button"
            aria-pressed={scope === "china"}
            className={scope === "china" ? "is-active" : ""}
            onClick={() => {
              setScope("china");
              setSelectedKey("");
              setClusterKeys([]);
              frameScope("china");
            }}
          >
            <MapPin size={15} />
            中国
          </button>
          <button
            type="button"
            aria-pressed={scope === "world"}
            className={scope === "world" ? "is-active" : ""}
            onClick={() => {
              setScope("world");
              setSelectedKey("");
              setClusterKeys([]);
              frameScope("world");
            }}
          >
            <Globe2 size={15} />
            世界
          </button>
        </div>
        <button
          type="button"
          className="visual-text-button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value);
            requestAnimationFrame(() =>
              section.current?.scrollIntoView({ block: "start" }),
            );
          }}
        >
          {expanded ? <Shrink size={17} /> : <Expand size={17} />}
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      <div className="map-statistics" aria-label="全部成员的位置统计">
        <span>
          共 <strong>{summary.total}</strong> 人
        </span>
        <span>
          <i className="dot-domestic" />
          中国 <strong>{summary.domestic}</strong>
        </span>
        <span>
          <i className="dot-overseas" />
          境外 <strong>{summary.overseas}</strong>
        </span>
        <span>
          <i className="dot-unlocated" />
          待定位 <strong>{summary.unlocated}</strong>
        </span>
      </div>
      <div className="map-stage">
        <div
          className="leaflet-map"
          ref={element}
          aria-label={`${scope === "china" ? "中国" : "世界"}地图，可拖动和双指缩放，城市按钮可用键盘选择`}
        />
        {status === "loading" && (
          <div className="map-load-note" role="status">
            <span className="map-loading-dot" />
            地图加载中
          </div>
        )}
        {status === "error" && (
          <div className="map-load-error" role="status">
            <span>已切换为简洁地图，所有城市仍可查看。</span>
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              <RotateCw size={15} />
              重试
            </button>
          </div>
        )}
        {selected && (
          <div
            className="map-city-detail"
            ref={detail}
            tabIndex={-1}
            aria-label={`${selected.city || "城市待补充"}的成员`}
          >
            <div className="map-city-detail-heading">
              <div>
                <strong>{selected.city || "城市待补充"}</strong>
                <span>
                  {[selected.country, selected.province]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  · {selected.people.length} 人
                </span>
              </div>
              <button
                type="button"
                className="visual-icon-button"
                aria-label="关闭城市成员"
                onClick={() => setSelectedKey("")}
              >
                <X size={18} />
              </button>
            </div>
            {!selected.point && (
              <p className="visual-note">
                这个城市暂未匹配到坐标，成员资料仍可查看。
              </p>
            )}
            <div className="map-city-people">
              {selected.people.map((person) => (
                <button
                  type="button"
                  key={person.id}
                  data-person-id={person.id}
                  onClick={(event) => onSelect(person.id, event.currentTarget)}
                >
                  <span className="map-person-avatar">
                    <span>{person.name.slice(-1)}</span>
                    {person.photoUrl && (
                      <img
                        src={person.photoUrl}
                        alt=""
                        onLoad={(event) => {
                          event.currentTarget.style.display = "";
                        }}
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    )}
                  </span>
                  <span className="map-person-name">
                    {person.name}
                    {labels[person.id] && <small>{labels[person.id]}</small>}
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!selected && selectedCluster.length > 0 && (
          <div
            className="map-city-detail"
            ref={detail}
            tabIndex={-1}
            aria-label="相邻城市的成员"
          >
            <div className="map-city-detail-heading">
              <div>
                <strong>{selectedCluster.length} 座城市</strong>
                <span>
                  共{" "}
                  {selectedCluster.reduce(
                    (total, group) => total + group.people.length,
                    0,
                  )}{" "}
                  人 · 选择城市查看成员
                </span>
              </div>
              <button
                type="button"
                className="visual-icon-button"
                aria-label="关闭相邻城市"
                onClick={() => setClusterKeys([])}
              >
                <X size={18} />
              </button>
            </div>
            <div className="map-city-people">
              {selectedCluster.map((group) => (
                <button
                  type="button"
                  key={group.key}
                  onClick={() => chooseCity(group)}
                >
                  <span className="map-person-name">
                    {group.city}
                    <small>
                      {[group.country, group.province]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                  <span>{group.people.length} 人 ›</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="map-directory">
        <div className="map-directory-title">
          <h3>大家的城市</h3>
          <span>点城市，再找人</span>
        </div>
        <div className="map-city-list">
          {summary.groups.map((group) => (
            <button
              type="button"
              key={group.key}
              className={`map-city-item${selectedKey === group.key ? " is-selected" : ""}`}
              aria-expanded={selectedKey === group.key}
              onClick={() => chooseCity(group)}
            >
              <span
                className={`map-city-symbol${group.outsideChina ? " is-overseas" : ""}`}
              >
                {group.point ? <MapPin size={18} /> : <Users size={18} />}
              </span>
              <span className="map-city-copy">
                <strong>{group.city || "城市待补充"}</strong>
                <small>
                  {[group.country, group.province]
                    .filter(Boolean)
                    .join(" · ") || "所在城市尚未填写"}
                  {!group.point
                    ? " · 待定位"
                    : scope === "china" && group.outsideChina
                      ? " · 世界地图可见"
                      : ""}
                </small>
              </span>
              <span className="map-city-count">{group.people.length} 人</span>
              <ChevronDown size={15} />
            </button>
          ))}
        </div>
        {!summary.total && (
          <p className="visual-empty">
            还没有成员。填写所在城市后，会自动标注在这里。
          </p>
        )}
        <p className="visual-note map-coordinate-note">
          标记表示填写的城市，不是实时位置。城市数据：
          <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
            GeoNames
          </a>
          、
          <a
            href="https://github.com/public-wheels/china-cities"
            target="_blank"
            rel="noreferrer"
          >
            china-cities
          </a>
          （
          <a href={cityDataLicenseUrl} target="_blank" rel="noreferrer">
            许可
          </a>
          ） 。
        </p>
      </div>
    </section>
  );
}
