import { Person } from '../../services/api';
import { buildPersonMapModel, MapCity, MapScope } from './model';
import { buildWorldOverview, OverviewCity, OverviewCluster } from './world-overview-model';

declare function Component(options: any): void;

function emitCity(component: any, city: MapCity): void {
  component.triggerEvent('citytap', {
    key: city.key,
    city: city.city,
    country: city.country,
    personIds: city.personIds
  });
}

Component({
  properties: {
    people: { type: Array, value: [] },
    scope: { type: String, value: 'china' },
    selectedKey: { type: String, value: '' }
  },
  data: {
    cities: [] as MapCity[],
    overviewClusters: [] as OverviewCluster[],
    overviewChoiceCities: [] as OverviewCity[],
    markers: [] as any[],
    includePoints: [] as { latitude: number; longitude: number }[],
    centerLatitude: 35,
    centerLongitude: 104,
    scale: 4,
    mapError: false
  },
  observers: {
    'people,scope': function(this: any) { this.rebuild(); },
    selectedKey: function(this: any) { this.refreshSelection(); }
  },
  lifetimes: {
    attached(this: any) { this.rebuild(); }
  },
  methods: {
    rebuild(this: any) {
      const scope: MapScope = this.properties.scope === 'world' ? 'world' : 'china';
      const model = buildPersonMapModel(this.properties.people as Person[], scope, this.properties.selectedKey);
      this.setData({ ...model, overviewClusters: scope === 'world' ? buildWorldOverview(model.cities, this.properties.selectedKey) : [], overviewChoiceCities: [] });
    },
    refreshSelection(this: any) {
      const scope: MapScope = this.properties.scope === 'world' ? 'world' : 'china';
      const model = buildPersonMapModel(this.properties.people as Person[], scope, this.properties.selectedKey);
      const selected = model.cities.find(city => city.key === this.properties.selectedKey);
      // The city index below the map can focus distant cities one by one.
      this.setData(selected ? {
        markers: model.markers,
        overviewClusters: scope === 'world' ? buildWorldOverview(model.cities, this.properties.selectedKey) : [],
        overviewChoiceCities: [],
        centerLatitude: selected.latitude,
        centerLongitude: selected.longitude,
        scale: scope === 'world' ? 5 : 6,
        includePoints: []
      } : { ...model, overviewClusters: scope === 'world' ? buildWorldOverview(model.cities, '') : [], overviewChoiceCities: [] });
    },
    onMarkerTap(this: any, event: any) {
      const markerId = Number(event.detail?.markerId ?? event.markerId);
      if (!Number.isInteger(markerId) || markerId < 1) return;
      const city: MapCity | undefined = this.data.cities[markerId - 1];
      if (city) emitCity(this, city);
    },
    onOverviewTap(this: any, event: any) {
      const cluster: OverviewCluster | undefined = this.data.overviewClusters.find((item: OverviewCluster) => item.id === event.currentTarget?.dataset?.id);
      if (!cluster) return;
      if (cluster.cityCount > 1) { this.setData({ overviewChoiceCities: cluster.cities }); return; }
      const city: MapCity | undefined = this.data.cities.find((item: MapCity) => item.key === cluster.cities[0].key);
      if (city) { this.setData({ overviewChoiceCities: [] }); emitCity(this, city); }
    },
    onOverviewCityTap(this: any, event: any) {
      const city: MapCity | undefined = this.data.cities.find((item: MapCity) => item.key === event.currentTarget?.dataset?.key);
      if (city) { this.setData({ overviewChoiceCities: [] }); emitCity(this, city); }
    },
    onBackToOverview(this: any) { this.triggerEvent('overview'); },
    onMapError(this: any) { this.setData({ mapError: true }); },
    onMapUpdated(this: any) {
      if (this.data.mapError) this.setData({ mapError: false });
    }
  }
});
