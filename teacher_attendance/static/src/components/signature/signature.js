/** @odoo-module **/

import { Component, useRef, onMounted } from "@odoo/owl";

export class SignaturePad extends Component {
    static template = "teacher_attendance.SignaturePad";
    static props = {
        onSave: Function,
        onCancel: Function,
    };

    setup() {
        this.canvasRef = useRef("signatureCanvas");
        this.isDrawing = false;
        this.ctx = null;

        onMounted(() => {
            this.initCanvas();
        });
    }

    initCanvas() {
        const canvas = this.canvasRef.el;
        this.ctx = canvas.getContext("2d");
        this.ctx.strokeStyle = "#000";
        this.ctx.lineWidth = 2;
        this.ctx.lineCap = "round";

        // Prevent scrolling when touching the canvas
        canvas.addEventListener("touchstart", (e) => {
            if (e.target === canvas) e.preventDefault();
        }, { passive: false });
        canvas.addEventListener("touchend", (e) => {
            if (e.target === canvas) e.preventDefault();
        }, { passive: false });
        canvas.addEventListener("touchmove", (e) => {
            if (e.target === canvas) e.preventDefault();
        }, { passive: false });
    }

    getPointerPos(ev) {
        const rect = this.canvasRef.el.getBoundingClientRect();
        const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
        const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
        return {
            x: clientX - rect.left,
            y: clientY - rect.top,
        };
    }

    startDrawing(ev) {
        this.isDrawing = true;
        const pos = this.getPointerPos(ev);
        this.ctx.beginPath();
        this.ctx.moveTo(pos.x, pos.y);
    }

    draw(ev) {
        if (!this.isDrawing) return;
        const pos = this.getPointerPos(ev);
        this.ctx.lineTo(pos.x, pos.y);
        this.ctx.stroke();
    }

    stopDrawing() {
        this.isDrawing = false;
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvasRef.el.width, this.canvasRef.el.height);
    }

    save() {
        const dataURL = this.canvasRef.el.toDataURL("image/png");
        this.props.onSave(dataURL);
    }
}
