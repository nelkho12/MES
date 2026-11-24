# Manufacturing Execution System — Standalone Desktop & Remote SQL IP Guide

Manufacturing Execution System runs directly against **PostgreSQL** with **SQL-backed operator accounts** (no Firebase or cloud login required).

## 1. Configure PostgreSQL Server for LAN IP Access

On your database host machine (for example `192.168.1.50`):

1. Create the database and user:
   ```sql
   CREATE USER kettler_app WITH PASSWORD 'your_strong_password';
   CREATE DATABASE kettler_mes OWNER kettler_app;
   ```
2. Edit `postgresql.conf`:
   ```ini
   listen_addresses = '*'
   port = 5432
   ```
3. Edit `pg_hba.conf` to permit your plant desktop subnet:
   ```ini
   host    kettler_mes    kettler_app    192.168.1.0/24    scram-sha-256
   ```
4. Restart PostgreSQL and allow TCP port `5432` in the server firewall.

## 2. Run Manufacturing Execution System Individually on a Desktop Workstation

### Option A — Standalone Desktop Window (Zero-Build Launcher)
```bash
npm install
npm run build
npm run desktop:local
```
- Opens Manufacturing Execution System in a standalone desktop application window (`http://127.0.0.1:3000`).
- Persists your SQL IP configuration in `~/.kettler-mes/db-config.json`.

### Option B — Browser Desktop App (PWA)
- Open Manufacturing Execution System in Chrome or Microsoft Edge and click **Install Standalone App** (or the address-bar Install icon) to add Manufacturing Execution System as an isolated desktop app on Windows, macOS, or Linux.

### Option C — Native Packaged Desktop Installer (`.exe` / `.dmg` / `.AppImage`)
```bash
npm install
npm run build
cd desktop
npm install
npm run dist
```

## 3. Connect to PostgreSQL by IP Address in the App

1. On the sign-in screen (or inside **SQL IP & Desktop** in the sidebar), click **SQL Server IP**.
2. Enter your database **IP Address** (e.g. `192.168.1.50`), **Port** (`5432`), **Database Name** (`kettler_mes`), **SQL Username**, and **SQL Password**.
3. Keep **Automatically create / verify MES SQL tables on connect** checked.
4. Click **Test Connection**, then **Save & Connect to SQL IP**.
5. Switch to **Create SQL Account** to register your first plant admin/operator directly in PostgreSQL.
