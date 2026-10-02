import { Person } from '../../services/api';
import { buildPersonMapModel, MapCity, MapScope } from './model';

declare function Component(options: any): void;

Component({
  properties: {
    people: { type: Array, value: [] },
    scope: { type: String, value: 'china' },
    selectedKey: { type: String, value: '' }
  },
  data: {
    cities: [] as MapCity[],
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
      this.setData(model);
    },
    refreshSelection(this: any) {
      const scope: MapScope = this.properties.scope === 'world' ? 'world' : 'china';
      const model = buildPersonMapModel(this.properties.people as Person[], scope, this.properties.selectedKey);
      const selected = model.cities.find(city => city.key === this.properties.selectedKey);
      // The city index below the map can focus distant cities one by one.
      this.setData(selected ? {
        markers: model.markers,
        centerLatitude: selected.latitude,
        centerLongitude: selected.longitude,
        scale: scope === 'world' ? 5 : 6,
        includePoints: []
      } : { markers: model.markers });
    },
    onMarkerTap(this: any, event: any) {
      const markerId = Number(event.detail?.markerId ?? event.markerId);
      if (!Number.isInteger(markerId) || markerId < 1) return;
      const city: MapCity | undefined = this.data.cities[markerId - 1];
      if (city) this.triggerEvent('citytap', {
        key: city.key,
        city: city.city,
        country: city.country,
        personIds: city.personIds
      });
    },
    onMapError(this: any) { this.setData({ mapError: true }); },
    onMapUpdated(this: any) {
      if (this.data.mapError) this.setData({ mapError: false });
    }
  }
});
