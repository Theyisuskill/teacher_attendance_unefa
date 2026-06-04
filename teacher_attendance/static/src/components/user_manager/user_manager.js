/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { _t } from "@web/core/l10n/translation";
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
            currentView: "list", // 'list', 'form'
            editingUser: null,
            isLoading: true,
            formData: this._getEmptyForm(),
            groups: [],
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
            attendance_pin: "",
            groups_id: [],
            active: true,
        };
    }

    async loadData() {
        this.state.isLoading = true;
        try {
            const [users, groups] = await Promise.all([
                this.orm.searchRead(
                    "res.users",
                    [],
                    ["name", "login", "email", "phone", "attendance_pin", "active", "groups_id"],
                    { order: "name asc" }
                ),
                this.orm.searchRead(
                    "res.groups",
                    [["category_id", "!=", false]],
                    ["name", "category_id"],
                    { order: "name asc" }
                ),
            ]);

            this.state.users = users;
            this.state.filteredUsers = users;
            this.state.groups = groups;
        } catch (error) {
            this.notification.add("Error al cargar datos", { type: "danger" });
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
                (u.email && u.email.toLowerCase().includes(query))
        );
    }

    showCreateForm() {
        this.state.editingUser = null;
        this.state.formData = this._getEmptyForm();
        this.state.currentView = "form";
    }

    showEditForm(userId) {
        const u = this.state.users.find((user) => user.id === userId);
        if (!u) return;

        this.state.editingUser = u;
        this.state.formData = {
            name: u.name || "",
            login: u.login || "",
            email: u.email || "",
            phone: u.phone || "",
            attendance_pin: u.attendance_pin || "",
            groups_id: u.groups_id || [],
            active: u.active !== false,
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingUser = null;
        this.state.formData = this._getEmptyForm();
    }

    onFormFieldChange(field, value) {
        this.state.formData[field] = value;
    }

    async saveUser() {
        const { formData, editingUser } = this.state;

        if (!formData.name || !formData.login) {
            this.notification.add("Nombre y login son obligatorios", { type: "warning" });
            return;
        }

        try {
            if (editingUser) {
                await this.orm.write("res.users", [editingUser.id], {
                    name: formData.name,
                    email: formData.email,
                    phone: formData.phone,
                    attendance_pin: formData.attendance_pin,
                    active: formData.active,
                });
                this.notification.add("Usuario actualizado correctamente", { type: "success" });
            } else {
                if (!formData.email) {
                    this.notification.add("El email es obligatorio para nuevos usuarios", { type: "warning" });
                    return;
                }
                await this.orm.create("res.users", [{
                    name: formData.name,
                    login: formData.login,
                    email: formData.email,
                    phone: formData.phone,
                    attendance_pin: formData.attendance_pin,
                    active: formData.active,
                }]);
                this.notification.add("Usuario creado correctamente", { type: "success" });
            }

            await this.loadData();
            this.cancelForm();
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar usuario", { type: "danger" });
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
        const u = this.state.users.find((user) => user.id === userId);
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

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard");
    }
}

registry.category("actions").add("action_user_manager", UserManager);
