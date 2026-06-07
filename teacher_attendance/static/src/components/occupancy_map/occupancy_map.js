/** @odoo-module **/

import { Component, onMounted, useRef, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class OccupancyMap extends Component {
    static template = "teacher_attendance.OccupancyMap";

    setup() {
        this.orm = useService("orm");
        this.mapContainer = useRef("mapContainer");
        this.map = null;
        this.markers = [];
        this.state = useState({
            mapLoaded: false,
            occupiedCount: 0,
            emptyCount: 0,
            activeCount: 0,
        });

        onMounted(async () => {
            try {
                await this.initMap();
                await this.loadAulas();
                this.state.mapLoaded = true;
            } catch (error) {
                console.error('Error in occupancy map mount:', error);
                this.state.mapLoaded = true; // Mostrar error si es necesario
            }
        });

        onWillUnmount(() => {
            if (this._onResize) window.removeEventListener('resize', this._onResize);
            if (this.map) this.map.remove();
        });
    }

    async initMap() {
        if (!window.L) {
            await this._loadLeaflet();
        }
        // Esperar a que el contenedor esté disponible
        if (!this.mapContainer.el) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        try {
            // UNEFA coordinates (Caracas, Venezuela)
            this.map = L.map(this.mapContainer.el, {
                preferCanvas: true,
                dragging: true,
                scrollWheelZoom: true,
                doubleClickZoom: true,
                touchZoom: true,
                zoomControl: true,
            }).setView([10.4806, -66.9036], 13);

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
                maxZoom: 19
            }).addTo(this.map);

            // Trigger resize after map initialization
            setTimeout(() => {
                if (this.map) {
                    this.map.invalidateSize();
                }
            }, 500);

            // Recalcular tamaño cuando cambia la ventana
            this._onResize = () => this.map && this.map.invalidateSize();
            window.addEventListener('resize', this._onResize);
        } catch (error) {
            console.error('Error initializing map:', error);
        }
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
            ["classroom_id", "check_in", "check_out"]
        );

        // Aulas con asistencia válida
        const occupiedIds = new Set();
        const activeIds = new Set();
        const now = new Date();

        activeLogs.forEach(log => {
            const checkOut = log.check_out || null;
            // Si no tiene check_out, está activa en clase
            if (!checkOut) {
                activeIds.add(log.classroom_id[0]);
            } else {
                occupiedIds.add(log.classroom_id[0]);
            }
        });

        let occupied = 0, empty = 0, active = 0;

        aulas.forEach(aula => {
            if (aula.latitude && aula.longitude) {
                let color, label, count;

                if (activeIds.has(aula.id)) {
                    color = "#F1D88B"; // Amarillo UNEFA
                    label = `${aula.name} - Clase en progreso`;
                    active++;
                } else if (occupiedIds.has(aula.id)) {
                    color = "#6E8FC7"; // Azul UNEFA
                    label = `${aula.name} - Ocupada hoy`;
                    occupied++;
                } else {
                    color = "#DE979D"; // Rosa UNEFA
                    label = `${aula.name} - Vacía`;
                    empty++;
                }

                const marker = L.circleMarker([aula.latitude, aula.longitude], {
                    radius: 12,
                    fillColor: color,
                    color: "#fff",
                    weight: 2.5,
                    opacity: 1,
                    fillOpacity: 0.85
                }).addTo(this.map);

                marker.bindPopup(`<b>${label}</b>`);
                this.markers.push(marker);
            }
        });

        this.state.occupiedCount = occupied;
        this.state.emptyCount = empty;
        this.state.activeCount = active;

        if (this.markers.length > 0) {
            const group = new L.featureGroup(this.markers);
            this.map.fitBounds(group.getBounds().pad(0.1));
        }
    }

    _loadLeaflet() {
        return new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            link.onerror = (e) => console.error('Leaflet CSS failed to load:', e);
            document.head.appendChild(link);

            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = () => {
                console.log('Leaflet loaded successfully');
                resolve();
            };
            script.onerror = (e) => {
                console.error('Leaflet JS failed to load:', e);
                reject(new Error('Failed to load Leaflet library'));
            };
            document.head.appendChild(script);
        });
    }
}

registry.category("actions").add("attendance_occupancy_map", OccupancyMap);
