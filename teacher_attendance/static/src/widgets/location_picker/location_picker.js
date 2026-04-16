/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Component, onMounted, useRef, useState, onWillUnmount } from "@odoo/owl";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

export class LocationPicker extends Component {
    static template = "teacher_attendance.LocationPicker";
    static props = {
        ...standardFieldProps,
    };

    setup() {
        this.mapContainer = useRef("mapContainer");
        this.map = null;
        this.marker = null;
        this.state = useState({
            lat: this.props.record.data.latitude || 0,
            lng: this.props.record.data.longitude || 0,
        });

        onMounted(() => {
            this.initMap();
        });

        onWillUnmount(() => {
            if (this.map) {
                this.map.remove();
            }
        });
    }

    initMap() {
        if (!window.L) {
            // Load Leaflet dynamically if not loaded
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);

            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = () => this._createMap();
            document.head.appendChild(script);
        } else {
            this._createMap();
        }
    }

    _createMap() {
        const initialLat = this.state.lat || -12.04637; // Default to Lima or somewhere
        const initialLng = this.state.lng || -77.04279;

        this.map = L.map(this.mapContainer.el).setView([initialLat, initialLng], 15);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(this.map);

        this.marker = L.marker([initialLat, initialLng], { draggable: true }).addTo(this.map);

        this.marker.on('dragend', (event) => {
            const position = event.target.getLatLng();
            this.updateCoords(position.lat, position.lng);
        });

        this.map.on('click', (event) => {
            const position = event.latlng;
            this.marker.setLatLng(position);
            this.updateCoords(position.lat, position.lng);
        });
    }

    async updateCoords(lat, lng) {
        this.state.lat = lat;
        this.state.lng = lng;
        await this.props.record.update({
            latitude: lat,
            longitude: lng,
        });
    }

    async getCurrentLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(async (position) => {
                const { latitude, longitude } = position.coords;
                this.marker.setLatLng([latitude, longitude]);
                this.map.setView([latitude, longitude], 15);
                await this.updateCoords(latitude, longitude);
            });
        }
    }
}

export const locationPicker = {
    component: LocationPicker,
    supportedTypes: ["float"],
};

registry.category("fields").add("location_picker", locationPicker);
