/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { Dialog } from "@web/core/dialog/dialog";

export class UserManager extends Component {
    static template = "teacher_attendance.UserManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.state = useState({
            users: [],
            filteredUsers: [],
            searchQuery: "",
            currentView: "list",
            editingUser: null,
            isLoading: true,
            formData: this._getEmptyForm(),
        });

        onWillStart(async () => {
            await this.loadData();
        });
    }

    _getEmptyForm() {
        return {
            name: "",
            login: "",
            email: "",
            phone: "",
            vat: "",
            attendance_role: "none",
            attendance_pin: "",
            new_password: "",
            confirm_password: "",
            active: true,
        };
    }

    async loadData() {
        this.state.isLoading = true;
        try {
            const users = await this.orm.searchRead(
                "res.users",
                [],
                ["name", "login", "email", "phone", "vat", "attendance_role", "attendance_pin", "active"],
                { order: "name asc" }
            );

            this.state.users = users || [];
            this.state.filteredUsers = users || [];
        } catch (error) {
            console.error("Error loading users:", error);
            this.notification.add("Error al cargar datos", { type: "danger" });
            this.state.users = [];
            this.state.filteredUsers = [];
        }
        this.state.isLoading = false;
    }

    onSearchInput(ev) {
        this.state.searchQuery = ev.target.value;
        this.filterUsers();
    }

    filterUsers() {
        const query = this.state.searchQuery.toLowerCase();
        if (!query) {
            this.state.filteredUsers = this.state.users;
            return;
        }
        this.state.filteredUsers = this.state.users.filter(
            (u) =>
                u.name.toLowerCase().includes(query) ||
                u.login.toLowerCase().includes(query) ||
                (u.email && u.email.toLowerCase().includes(query)) ||
                (u.vat && u.vat.toLowerCase().includes(query))
        );
    }

    showCreateForm() {
        this.state.editingUser = null;
        this.state.formData = this._getEmptyForm();
        this.state.currentView = "form";
    }

    showEditForm(userId) {
        const u = this.state.users.find((usr) => usr.id === userId);
        if (!u) return;
        this.state.editingUser = u;
        this.state.formData = {
            name: u.name || "",
            login: u.login || "",
            email: u.email || "",
            phone: u.phone || "",
            vat: u.vat || "",
            attendance_role: u.attendance_role || "none",
            attendance_pin: u.attendance_pin || "",
            new_password: "",
            confirm_password: "",
            active: u.active !== false,
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingUser = null;
        this.state.formData = this._getEmptyForm();
    }

    async saveUser() {
        const { formData, editingUser } = this.state;

        if (!formData.name || !formData.login) {
            this.notification.add("Nombre y login son obligatorios", { type: "warning" });
            return;
        }

        try {
            const vals = {
                name: formData.name,
                email: formData.email,
                phone: formData.phone,
                vat: formData.vat,
                attendance_role: formData.attendance_role,
                attendance_pin: formData.attendance_pin || false,
                active: formData.active,
            };

            if (editingUser) {
                await this.orm.write("res.users", [editingUser.id], vals);
                if (formData.new_password) {
                    await this._changePassword(editingUser.id, formData.new_password, formData.confirm_password);
                } else {
                    this.notification.add("Usuario actualizado correctamente", { type: "success" });
                }
            } else {
                if (!formData.email) {
                    this.notification.add("El email es obligatorio para nuevos usuarios", { type: "warning" });
                    return;
                }
                vals.login = formData.login;
                if (formData.new_password) {
                    vals.new_password = formData.new_password;
                }
                await this.orm.create("res.users", [vals]);
                this.notification.add("Usuario creado correctamente", { type: "success" });
            }
            await this.loadData();
            this.cancelForm();
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar usuario", { type: "danger" });
        }
    }

    async _changePassword(userId, newPassword, confirmPassword) {
        if (!newPassword) {
            this.notification.add("La contraseña no puede estar vacía", { type: "warning" });
            return false;
        }
        if (newPassword !== confirmPassword) {
            this.notification.add("Las contraseñas no coinciden", { type: "warning" });
            return false;
        }
        try {
            await this.orm.call("res.users", "_change_password", [[userId], newPassword]);
            this.notification.add("Contraseña actualizada correctamente", { type: "success" });
            return true;
        } catch (error) {
            this.notification.add(error.data?.message || "Error al cambiar contraseña", { type: "danger" });
            return false;
        }
    }

    async deleteUser(userId) {
        this.dialog.add(Dialog, {
            title: "Confirmar eliminación",
            body: "¿Está seguro de que desea eliminar este usuario? Esta acción no se puede deshacer.",
            confirm: async () => {
                try {
                    await this.orm.unlink("res.users", [userId]);
                    this.notification.add("Usuario eliminado", { type: "success" });
                    await this.loadData();
                } catch (error) {
                    this.notification.add("No se puede eliminar el usuario", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    async toggleUserActive(userId) {
        const u = this.state.users.find((usr) => usr.id === userId);
        if (!u) return;
        try {
            await this.orm.write("res.users", [userId], { active: !u.active });
            this.notification.add(
                u.active ? "Usuario desactivado" : "Usuario activado",
                { type: "success" }
            );
            await this.loadData();
        } catch (error) {
            this.notification.add("Error al cambiar estado", { type: "danger" });
        }
    }

    get roleLabels() {
        return {
            none: "Sin rol",
            employee: "Empleado",
            teacher: "Docente",
            coordinator: "Coordinador",
        };
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_user_manager", UserManager);