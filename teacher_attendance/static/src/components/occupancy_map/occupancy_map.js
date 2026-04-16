/** @odoo-module **/

import { Component, onMounted, useRef, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class OccupancyMap extends Component {
    static template = "teacher_attendance.OccupancyMap";

    setup() {
        this.orm = useService("orm");
        this.mapContainer = useRef("mapContainer");
        this.map = null;
        this.markers = [];

        onMounted(async () => {
            await this.initMap();
            await this.loadAulas();
        });

        onWillUnmount(() => {
            if (this.map) this.map.remove();
        });
    }

    async initMap() {
        if (!window.L) {
            await this._loadLeaflet();
        }
        this.map = L.map(this.mapContainer.el).setView([-12.046, -77.042], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(this.map);
    }

    async loadAulas() {
        const aulas = await this.orm.searchRead(
            "attendance.classroom",
            [],
            ["name", "latitude", "longitude", "radius"]
        );

        const today = new Date().toISOString().split('T')[0];
        const activeLogs = await this.orm.searchRead(
            "attendance.log",
            [["check_in", ">=", today + " 00:00:00"], ["status", "=", "valid"]],
            ["classroom_id"]
        );

        const occupiedIds = new Set(activeLogs.map(l => l.classroom_id[0]));

        aulas.forEach(aula => {
            if (aula.latitude && aula.longitude) {
                const isOccupied = occupiedIds.has(aula.id);
                const color = isOccupied ? "green" : "gray";
                
                const marker = L.circleMarker([aula.latitude, aula.longitude], {
                    radius: 10,
                    fillColor: color,
                    color: "#fff",
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 0.8
                }).addTo(this.map);

                marker.bindPopup(`<b>${aula.name}</b><br>Status: ${isOccupied ? "Occupied" : "Empty"}`);
                this.markers.push(marker);
            }
        });

        if (this.markers.length > 0) {
            const group = new L.featureGroup(this.markers);
            this.map.fitBounds(group.getBounds());
        }
    }

    _loadLeaflet() {
        return new Promise((resolve) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);

            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = resolve;
            document.head.appendChild(script);
        });
    }
}

registry.category("actions").add("attendance_occupancy_map", OccupancyMap);
