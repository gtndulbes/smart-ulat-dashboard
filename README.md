# 🐛 Smart Ulat Hongkong IoT Dashboard

Sistem **Monitoring & Kontrol Kandang Ulat Hongkong Berbasis IoT** dengan **Fuzzy-PID Adaptive Control** dan **Self-Monitoring System**.

Bagian dari Tugas Akhir:

> **"Rancang Bangun Sistem Monitoring dan Kontrol Kandang Ulat Hongkong Berbasis IoT dengan Fuzzy-PID dan Self-Monitoring Sistem"**

**Universitas Wijayakusuma Purwokerto**
Program Studi Teknik Elektro
Fakultas Teknik — 2026

---

## 📖 Daftar Isi

* [Fitur Utama](#-fitur-utama)
* [Arsitektur Sistem](#-arsitektur-sistem)
* [Stack Teknologi](#-stack-teknologi)
* [Struktur Project](#-struktur-project)
* [Persyaratan Sistem](#-persyaratan-sistem)
* [Quick Start](#-quick-start)
* [Konfigurasi](#-konfigurasi)
* [Cara Pakai](#-cara-pakai)
* [Testing](#-testing)
* [Deployment](#-deployment)
* [Troubleshooting](#-troubleshooting)
* [Referensi](#-referensi)
* [Lisensi](#-lisensi)
* [Author](#-author)

---

## ✨ Fitur Utama

### 🎯 Kontrol Cerdas

* **Fuzzy-PID Adaptive Control** — Mamdani inference + Centroid defuzzification
* **Adaptive tuning** — Kp/Ki/Kd berubah otomatis sesuai error dan delta error
* **4 loop kontrol paralel:**

  * **Peltier** — kontrol suhu COOLING/HEATING
  * **Fan Temperature** — kontrol suhu
  * **Fan Humidity** — kontrol kelembaban
  * **Fan NH₃** — kontrol kualitas udara
* **MAX Operator** — exhaust fan menggunakan nilai maksimum dari 3 fan loop
* **PWM Tracking** — heatsink fan mengikuti Peltier
* **Humidity Interlock** — perlindungan otomatis terhadap risiko kondensasi

### 📊 Monitoring Realtime

* Suhu — target **26–29 °C**
* Kelembaban — target **60–90 %RH**
* NH₃ — target **< 25 ppm**
* Power monitoring — **V / I / P menggunakan INA219**
* Self-monitoring sensor, aktuator, dan koneksi
* Chart realtime dengan 3 sumbu dan time-range selector
* Monitoring nilai intermediate Fuzzy-PID:

  * Kp
  * Ki
  * Kd
  * ΔKp
  * ΔKi
  * ΔKd
  * PID Output

### 🛡️ Safety Priority

```text
1. SAFE_MODE — sensor error
2. NH₃ EMERGENCY — > 25 ppm
3. POWER CRITICAL
4. HUMIDITY INTERLOCK
5. Normal Fuzzy-PID
```

### 🌐 IoT & Connectivity

* **MQTT** melalui EMQX Cloud dengan TLS port `8883`
* **WebSocket** untuk realtime update ke seluruh client
* **Multi-user synchronization** — semua tab mendapatkan state terbaru
* **Offline resilience** — kontrol lokal tetap berjalan ketika WiFi/MQTT terputus
* **Alert system**:

  * Toast notification
  * Notification center
  * Telegram
  * Buzzer

### 💾 Data & Persistence

* Persistent configuration menggunakan file JSON
* Historical logging ke **Google Sheets** melalui **Google Apps Script**
* Export data ke CSV / Excel
* Auto-backup apabila configuration file mengalami kerusakan

### 📱 User Experience

* **Progressive Web App (PWA)** — dapat di-install pada Android, iOS, dan Windows
* Responsive dari layar **320px hingga TV 4K**
* **Dark SCADA Theme** dengan tampilan industrial futuristik
* Firmware menggunakan pendekatan **non-blocking** berbasis `millis()`
* Auto-reconnect:

  * WiFi
  * MQTT
  * WebSocket

---

## 🏗️ Arsitektur Sistem

```text
┌──────────────────────────────────────────────────────────────┐
│                        KANDANG ULAT                          │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐  │
│  │   SHT31-D   │    │    MQ-135    │    │     INA219      │  │
│  │    T + RH   │    │   NH₃ est.   │    │     V / I / P   │  │
│  └──────┬──────┘    └──────┬───────┘    └────────┬────────┘  │
│         │ I²C              │ ADC                 │ I²C       │
│         └──────────────────┼─────────────────────┘           │
│                            │                                 │
│                            ▼                                 │
│                  ┌──────────────────┐                        │
│                  │   ESP32 / C3     │                        │
│                  │   Fuzzy-PID      │                        │
│                  │ Self-Monitoring  │                        │
│                  └────────┬─────────┘                        │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐                │
│         ▼                 ▼                 ▼                │
│  ┌────────────┐   ┌──────────────┐   ┌────────────┐          │
│  │  Peltier   │   │ Exhaust Fan  │   │Heatsink Fan│          │
│  │ + BTS7960  │   │    (PWM)     │   │   (PWM)    │          │
│  └────────────┘   └──────────────┘   └────────────┘          │
└──────────────────────────────────────────────────────────────┘
                            │
                            │ MQTT over TLS (8883)
                            ▼
                ┌────────────────────────────┐
                │      EMQX CLOUD BROKER     │
                │      (Serverless Free)     │
                └─────────────┬──────────────┘
                              │
                              ▼
        ┌───────────────────────────────────────┐
        │      NODE.JS BACKEND (Render)         │
        │                                       │
        │  ┌─────────────┐   ┌───────────────┐  │
        │  │ MQTT Client │   │ WebSocket     │  │
        │  │    (TLS)    │   │    Server     │  │
        │  └──────┬──────┘   └───────┬───────┘  │
        │         │                  │          │
        │         ▼                  ▼          │
        │  ┌─────────────────────────────┐      │
        │  │   Central State Service     │      │
        │  │      (Source of Truth)      │      │
        │  └─────────────┬───────────────┘      │
        │                │                      │
        │    ┌───────────┼───────────┐          │
        │    ▼           ▼           ▼          │
        │ REST API    History    Alert Service  │
        └────┬───────────┬───────────┬──────────┘
             │           │           │
             ▼           ▼           ▼
      ┌──────────┐ ┌──────────────┐ ┌────────────┐
      │Dashboard │ │ Google Apps  │ │  Telegram  │
      │ Frontend │ │    Script    │ │    Bot     │
      │   (PWA)  │ │      ↓       │ └────────────┘
      │          │ │ Google Sheets│
      └──────────┘ └──────────────┘
```

---

## 🛠️ Stack Teknologi

### IoT Device

| Komponen               | Fungsi                         |
| ---------------------- | ------------------------------ |
| **ESP32 / ESP32-C3**   | Mikrokontroler utama           |
| **SHT31-D**            | Sensor suhu + kelembaban (I²C) |
| **MQ-135**             | Sensor kualitas udara (ADC)    |
| **INA219**             | Power monitoring V/I/P (I²C)   |
| **Peltier TEC1-12706** | Cooling / Heating              |
| **BTS7960**            | H-Bridge driver Peltier        |
| **Exhaust Fan**        | Ventilasi udara                |
| **Heatsink Fan**       | Cooling Peltier                |
| **Buzzer**             | Alert lokal                    |

### Backend

| Komponen           | Versi    |
| ------------------ | -------- |
| **Node.js**        | ≥ 18.0.0 |
| **Express**        | ^4.19.2  |
| **MQTT.js**        | ^5.10.1  |
| **ws (WebSocket)** | ^8.18.0  |
| **cors**           | ^2.8.5   |
| **dotenv**         | ^16.4.5  |

### Frontend

| Komponen               | Fungsi                  |
| ---------------------- | ----------------------- |
| **HTML5**              | Struktur                |
| **Tailwind CSS**       | Styling melalui CDN     |
| **Vanilla JavaScript** | Logic                   |
| **Chart.js v4**        | Grafik realtime         |
| **PWA**                | Installable application |

### Cloud & Services

| Service                | Fungsi                         |
| ---------------------- | ------------------------------ |
| **EMQX Cloud**         | MQTT broker — TLS / Serverless |
| **Render**             | Backend hosting                |
| **Google Apps Script** | Gateway ke Google Sheets       |
| **Google Sheets**      | Historical logging             |
| **Telegram Bot**       | External alert                 |
| **UptimeRobot**        | Monitoring / anti-sleep        |

### Firmware Libraries

| Library          | Versi  |
| ---------------- | ------ |
| **PubSubClient** | 2.8    |
| **ArduinoJson**  | 6.21.5 |

---

## 📁 Struktur Project

```text
smart-ulat-dashboard/
│
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── .env
│   ├── .env.example
│   │
│   ├── config/
│   │   └── config.js
│   │
│   ├── mqtt/
│   │   ├── mqttTopics.js
│   │   ├── mqttClient.js
│   │   ├── mqttHandlers.js
│   │   └── mqttPublisher.js
│   │
│   ├── websocket/
│   │   └── websocketServer.js
│   │
│   ├── api/
│   │   ├── healthRoutes.js
│   │   ├── statusRoutes.js
│   │   ├── controlRoutes.js
│   │   ├── configRoutes.js
│   │   └── historyRoutes.js
│   │
│   ├── services/
│   │   ├── stateService.js
│   │   ├── configService.js
│   │   ├── historyService.js
│   │   ├── googleAppsScriptService.js
│   │   ├── telegramService.js
│   │   └── alertService.js
│   │
│   ├── validation/
│   │   ├── commandValidation.js
│   │   └── configValidation.js
│   │
│   ├── middleware/
│   │   ├── security.js
│   │   └── errorHandler.js
│   │
│   ├── utils/
│   │   └── logger.js
│   │
│   ├── scripts/
│   │   ├── test-helpers.js
│   │   ├── simulate-esp32.js
│   │   └── test-scenarios.js
│   │
│   └── data/
│       └── .gitkeep
│
├── frontend/
│   ├── index.html
│   ├── offline.html
│   ├── manifest.json
│   ├── service-worker.js
│   │
│   ├── pages/
│   │   ├── dashboard.html
│   │   ├── monitoring.html
│   │   ├── fuzzy-pid.html
│   │   ├── power.html
│   │   ├── self-monitoring.html
│   │   ├── history.html
│   │   └── configuration.html
│   │
│   ├── css/
│   │   └── style.css
│   │
│   ├── js/
│   │   ├── utils.js
│   │   ├── charts.js
│   │   ├── websocket.js
│   │   ├── mqtt-state.js
│   │   ├── router.js
│   │   ├── alerts.js
│   │   ├── dashboard.js
│   │   ├── monitoring.js
│   │   ├── fuzzy-pid.js
│   │   ├── power.js
│   │   ├── self-monitoring.js
│   │   ├── configuration.js
│   │   ├── history.js
│   │   ├── pwa.js
│   │   └── app.js
│   │
│   └── assets/
│       └── icons/
│           ├── android/
│           ├── ios/
│           └── windows/
│
├── esp32/
│   └── smart_ulat_esp32.ino
│
├── google-apps-script/
│   └── Code.gs
│
├── .gitignore
├── README.md
├── INTEGRATION_TEST.md
└── package.json
```

---

## 💻 Persyaratan Sistem

### Development

* **Node.js** v18+
* **Git**
* **Arduino IDE 2.x**
* **ESP32 Board Package** melalui Boards Manager
* **MQTT Explorer** untuk debugging
* **ngrok** — opsional untuk testing eksternal

### Cloud Accounts

* **EMQX Cloud**
* **GitHub**
* **Render**
* **Google Account** untuk Google Sheets + Apps Script
* **Telegram** — opsional untuk Bot
* **UptimeRobot** — opsional

### Hardware

* ESP32 / ESP32-C3 / ESP32-S3 / ESP32-C6
* SHT31-D
* MQ-135
* INA219
* Peltier TEC1-12706
* BTS7960
* Exhaust Fan
* Heatsink Fan
* Buzzer
* Power supply 12V / 10A
* Buck converter
* Kabel, PCB, dan enclosure

---

## 🚀 Quick Start

### 1. Clone Project

```bash
git clone https://github.com/USERNAME/smart-ulat-dashboard.git
cd smart-ulat-dashboard
```

### 2. Setup Backend

```bash
cd backend
npm install
```

### 3. Konfigurasi `.env`

```bash
cp .env.example .env
```

Edit file `.env`:

```env
PORT=3000
NODE_ENV=development

# MQTT — EMQX Cloud
MQTT_BROKER_URL=mqtts://xxxxx.ala.asia-southeast1.emqxsl.com:8883
MQTT_USERNAME=smartulat_device
MQTT_PASSWORD=your_password
MQTT_CLIENT_ID=smart-ulat-backend

# Google Apps Script
GAS_WEB_APP_URL=
GAS_WEB_APP_TOKEN=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Simulation
SIMULATION_MODE=false

# Logging
LOG_LEVEL=info
```

> ⚠️ **Jangan pernah commit file `.env` ke GitHub.**

### 4. Jalankan Server

```bash
npm run dev
```

Expected:

```text
==================================================
  SMART ULAT HONGKONG — BACKEND
==================================================
  Service     : smart-ulat-backend
  Environment : development
  Port        : 3000
  Simulation  : false
  ...
[INFO ] [MQTT] ✅ Connected to MQTT broker
[INFO ] [MQTT] Subscribe 8 topik
[INFO ] [WS] WebSocket server siap di path /ws
==================================================
```

### 5. Buka Dashboard

```text
http://localhost:3000
```

### 6. Setup ESP32

Firmware berada di:

```text
esp32/smart_ulat_esp32.ino
```

---

## ⚙️ Konfigurasi

### Environment Variables

| Variable             | Deskripsi       | Contoh                               |
| -------------------- | --------------- | ------------------------------------ |
| `PORT`               | Port server     | `3000`                               |
| `NODE_ENV`           | Environment     | `development` / `production`         |
| `MQTT_BROKER_URL`    | Broker MQTT     | `mqtts://xxx.emqxsl.com:8883`        |
| `MQTT_USERNAME`      | Username MQTT   | `smartulat_device`                   |
| `MQTT_PASSWORD`      | Password MQTT   | `••••••••`                           |
| `MQTT_CLIENT_ID`     | Client ID       | `smart-ulat-backend`                 |
| `GAS_WEB_APP_URL`    | URL Apps Script | `https://script.google.com/.../exec` |
| `GAS_WEB_APP_TOKEN`  | Token GAS       | `smartulat-xxx`                      |
| `TELEGRAM_BOT_TOKEN` | Token Bot       | `123456:ABC...`                      |
| `TELEGRAM_CHAT_ID`   | Chat ID         | `987654321`                          |
| `SIMULATION_MODE`    | Mode simulasi   | `true` / `false`                     |
| `LOG_LEVEL`          | Level log       | `debug` / `info` / `warn` / `error`  |

### Setpoint Default

| Parameter     | Default | Range Optimal |
| ------------- | ------: | ------------: |
| Suhu          | 27.5 °C |      26–29 °C |
| Kelembaban    |  75 %RH |     60–90 %RH |
| NH₃           |  20 ppm |      < 25 ppm |
| NH₃ Emergency |  25 ppm |             — |

> Semua setpoint dapat dikonfigurasi melalui **Dashboard → Configuration**.

### MQTT Topics

| Topic                      | Arah            | Payload               |
| -------------------------- | --------------- | --------------------- |
| `smartulat/telemetry`      | ESP32 → Backend | T, RH, NH3            |
| `smartulat/actuator`       | ESP32 → Backend | Peltier, Fan status   |
| `smartulat/power`          | ESP32 → Backend | V, I, P               |
| `smartulat/selfmonitoring` | ESP32 → Backend | Status sensor/koneksi |
| `smartulat/fuzzypid`       | ESP32 → Backend | Fuzzy-PID values      |
| `smartulat/status`         | ESP32 → Backend | Mode, uptime, heap    |
| `smartulat/alert`          | ESP32 → Backend | Alert message         |
| `smartulat/response`       | ESP32 → Backend | Command response      |
| `smartulat/control`        | Backend → ESP32 | Command               |
| `smartulat/config`         | Backend → ESP32 | Config update         |

### REST API Endpoints

| Method | Endpoint                   | Fungsi             |
| ------ | -------------------------- | ------------------ |
| `GET`  | `/api/health`              | Health check       |
| `GET`  | `/api/status`              | Summary state      |
| `GET`  | `/api/status/full`         | Full state         |
| `GET`  | `/api/status/alerts`       | List alert         |
| `POST` | `/api/status/alerts/read`  | Mark alert as read |
| `POST` | `/api/status/alerts/clear` | Clear alert        |
| `GET`  | `/api/config`              | Get config         |
| `POST` | `/api/config`              | Update config      |
| `GET`  | `/api/config/export`       | Download config    |
| `POST` | `/api/config/import`       | Upload config      |
| `POST` | `/api/config/reset`        | Reset ke default   |
| `POST` | `/api/control`             | Kirim command      |
| `GET`  | `/api/control/schema`      | List command       |
| `GET`  | `/api/history`             | Historical data    |
| `GET`  | `/api/history/stats`       | GAS statistics     |

### Command List

| Command              | Value                         | Deskripsi                 |
| -------------------- | ----------------------------- | ------------------------- |
| `SET_PELTIER_PWM`    | 0–255                         | Set PWM Peltier           |
| `SET_PELTIER_MODE`   | `OFF` / `COOLING` / `HEATING` | Arah Peltier              |
| `SET_EXHAUST_PWM`    | 0–255                         | Set PWM exhaust           |
| `SET_EXHAUST_ON_OFF` | `ON` / `OFF` / 0 / 1          | On/off exhaust            |
| `SET_HEATSINK_PWM`   | 0–255                         | Set PWM heatsink          |
| `SET_MODE`           | `auto` / `manual`             | Mode kontrol              |
| `SET_TEMP_SETPOINT`  | °C                            | Setpoint suhu             |
| `SET_HUM_SETPOINT`   | %RH                           | Setpoint RH               |
| `SET_NH3_LIMIT`      | ppm                           | Limit NH₃                 |
| `SET_BUZZER`         | `OFF` / `TEST` / `SILENT`     | Kontrol buzzer            |
| `SAVE_CONFIG`        | —                             | Simpan konfigurasi ke NVS |
| `REBOOT`             | —                             | Reboot ESP32              |
| `EMERGENCY_STOP`     | —                             | Aktifkan SAFE_MODE        |
| `CLEAR_SAFE_MODE`    | —                             | Matikan SAFE_MODE         |

---

## 📱 Cara Pakai

### Dashboard Pages

| Halaman             | Fungsi                                              |
| ------------------- | --------------------------------------------------- |
| **Dashboard**       | Ringkasan sistem + Manual Control                   |
| **Monitoring**      | Chart realtime T, RH, NH₃, PWM, Power               |
| **Fuzzy-PID**       | Detail Fuzzy-PID 4 loop                             |
| **Power**           | Monitoring INA219                                   |
| **Self-Monitoring** | Status sensor, aktuator, dan koneksi                |
| **History**         | Log historis dari Google Sheets                     |
| **Configuration**   | Setting setpoint, PID, fuzzy, dan parameter lainnya |

### Control Mode

#### AUTO

* ESP32 menghitung aktuator secara otomatis berdasarkan sensor
* Fuzzy-PID berjalan adaptif
* Setpoint dapat dikirim dari dashboard

#### MANUAL

* User mengatur aktuator dari dashboard
* Automatic control logic dilewati
* Safety logic tetap aktif

Cara mengganti mode:

**Dashboard → Manual Control → AUTO / MANUAL**

### Emergency Stop

Aktifkan:

**Dashboard → Manual Control → 🛑 STOP**

Efek:

```text
Peltier      → OFF
Exhaust Fan  → 255
safeMode     → true
```

Matikan melalui tombol **Clear Safe** atau command:

```bash
curl -X POST http://localhost:3000/api/control \
  -H "Content-Type: application/json" \
  -d '{"command":"CLEAR_SAFE_MODE"}'
```

### SAFE_MODE

SAFE_MODE dapat aktif ketika:

* User menekan tombol STOP
* Terjadi sensor error

Recovery:

```text
Dashboard → Clear Safe
```

atau:

```text
CLEAR_SAFE_MODE
```

---

## 🧪 Testing

### Backend Test

Health check:

```bash
curl http://localhost:3000/api/health
```

Status:

```bash
curl http://localhost:3000/api/status
```

Kirim command:

```bash
curl -X POST http://localhost:3000/api/control \
  -H "Content-Type: application/json" \
  -d '{"command":"SET_PELTIER_PWM","value":120}'
```

### Simulator Tanpa ESP32

```bash
cd backend
```

Simulator kontinu:

```bash
npm run test:sim
```

Menu skenario:

```bash
npm run test:scenarios
```

### Firmware Test

1. Buka `esp32/smart_ulat_esp32.ino`
2. Update konfigurasi WiFi dan MQTT
3. Upload firmware
4. Buka Serial Monitor pada **115200 baud**

### MQTT Explorer

1. Connect ke EMQX Cloud
2. Gunakan TLS port `8883`
3. Subscribe:

```text
smartulat/#
```

4. Amati data realtime.

### Integration Test

Lihat:

```text
INTEGRATION_TEST.md
```

---

## 🚀 Deployment

### Render

#### Persiapan

1. Push repository ke GitHub
2. Siapkan UptimeRobot jika diperlukan

#### Deploy

1. Login ke Render menggunakan GitHub
2. Pilih **+ New → Web Service**
3. Connect repository `smart-ulat-dashboard`
4. Konfigurasi:

```text
Name           : smart-ulat-dashboard
Region         : Singapore
Branch         : main
Root Directory : backend
Runtime        : Node
Build Command  : npm install
Start Command  : npm start
Instance       : Free
```

5. Tambahkan environment variables:

```env
PORT=3000
NODE_ENV=production

MQTT_BROKER_URL=mqtts://xxx.emqxsl.com:8883
MQTT_USERNAME=smartulat_device
MQTT_PASSWORD=your_password
MQTT_CLIENT_ID=smart-ulat-backend

SIMULATION_MODE=false
LOG_LEVEL=info
```

6. Klik **Create Web Service**
7. Tunggu proses deployment selesai
8. Salin URL publik aplikasi

### UptimeRobot

Untuk monitoring uptime:

```text
Type     : HTTP(S)
URL      : https://smart-ulat-dashboard.onrender.com/api/health
Interval : 5 minutes
```

### ngrok

Untuk testing cepat:

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
ngrok http 3000
```

Gunakan URL HTTPS yang diberikan oleh ngrok.

---

## 🐛 Troubleshooting

### Backend Tidak Connect ke MQTT

| Error         | Kemungkinan Penyebab | Solusi                          |
| ------------- | -------------------- | ------------------------------- |
| `rc=5`        | Authentication salah | Cek username dan password MQTT  |
| `rc=-4`       | Timeout              | Cek host dan port `8883`        |
| `rc=-2`       | Network error        | Cek koneksi internet            |
| `certificate` | TLS configuration    | Pastikan menggunakan `mqtts://` |

### ESP32 Tidak Connect

| Error                   | Kemungkinan Penyebab   | Solusi                |
| ----------------------- | ---------------------- | --------------------- |
| `[WiFi] FAILED`         | SSID/password salah    | Cek konfigurasi WiFi  |
| `[MQTT] FAILED (rc=-4)` | Broker tidak reachable | Cek host dan port     |
| `[MQTT] FAILED (rc=5)`  | Authentication salah   | Cek username/password |

> ESP32 umumnya menggunakan jaringan WiFi **2.4 GHz**.

### Dashboard Kosong

1. Buka DevTools dengan `F12`
2. Cek console:

   ```text
   [WS] ✅ Connected
   ```
3. Cek indikator WebSocket di navbar
4. Refresh dengan:

   ```text
   Ctrl + Shift + R
   ```
5. Jika masih bermasalah, unregister Service Worker:

   ```text
   DevTools → Application → Service Workers → Unregister
   ```
6. Periksa backend log dan pastikan telemetry diterima.

### Firmware Compile Error

| Error                            | Solusi                                                  |
| -------------------------------- | ------------------------------------------------------- |
| `FuzzyPIDState was not declared` | Deklarasikan `struct FuzzyPIDState;` setelah `#include` |
| `max(float, double)`             | Gunakan `maxF()`, `fabsf()`, dan suffix `f`             |
| `PubSubClient.h not found`       | Install library melalui Library Manager                 |

### Google Apps Script Error 405

Pastikan deployment Apps Script memberikan akses:

```text
Who has access → Anyone
```

Kemudian:

1. Apps Script → **Deploy**
2. Pilih **Manage deployments**
3. Edit deployment
4. Pilih **New version**
5. Pastikan akses sesuai kebutuhan
6. Deploy kembali
7. Update `GAS_WEB_APP_URL` pada `.env`

### Config Hilang Setelah Restart

Periksa:

```text
backend/data/config.json
```

Pastikan:

* Folder `backend/data/` tersedia
* Folder dapat ditulis
* Tidak ada error pada log configuration service

---

## 📚 Referensi

### Dokumentasi Resmi

* [MQTT v3.1.1 Specification](http://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html)
* [EMQX Cloud Documentation](https://docs.emqx.com/en/cloud/latest/)
* [Chart.js Documentation](https://www.chartjs.org/docs/latest/)
* [Tailwind CSS Documentation](https://tailwindcss.com/docs)
* [Progressive Web Apps](https://web.dev/progressive-web-apps/)
* [Render Documentation](https://render.com/docs)

### Literatur Tugas Akhir

1. Punzo, F., & Mutchmor, J. A. (1980). *Effects of temperature, relative humidity and period of exposure on the survival capacity of Tenebrio molitor*. Journal of the Kansas Entomological Society.
2. Wang, X. et al. (2025). *Enhancing plastic decomposition in mealworms*. Advanced Energy and Sustainability Research.
3. Lahlouh, I. et al. (2020). *Experimental implementation of a new multi input multi output fuzzy-PID controller in a poultry house system*. Heliyon.
4. Li, L. et al. (2024). *Modeling and Regulation of Dynamic Temperature for Layer Houses*. Animals.
5. Kakar, J. K. et al. (2024). *TimeTector: A Twin-Branch Approach for Unsupervised Anomaly Detection*. Sensors.

### Tools

* [MQTT Explorer](http://mqtt-explorer.com) — MQTT debugging
* [Wokwi](https://wokwi.com) — ESP32 simulator
* [Maskable.app](https://maskable.app) — PWA icon generator
* [PWA Builder](https://www.pwabuilder.com) — PWA icon generator

---

## 📄 Lisensi

Project ini dibuat untuk **keperluan akademik (Tugas Akhir)**.

**Universitas Wijayakusuma Purwokerto**
Program Studi Teknik Elektro
Fakultas Teknik
2026

---

## 👤 Author

**Muhammad Gatan Rifani**

NIM: `23410300617`

Program Studi Teknik Elektro
Universitas Wijayakusuma Purwokerto

### Dosen Pembimbing

**Isra' Nuur Darmawan, S.T., M.Eng.**

NIDN: `0609038904`

---

## 🙏 Ucapan Terima Kasih

* Allah SWT
* Orang tua dan keluarga
* Dosen pembimbing
* Program Studi Teknik Elektro UWKP
* Kontributor open-source seperti EMQX, Node.js, Chart.js, Tailwind CSS, dan lainnya

---

<div align="center">

### 🐛 Smart Ulat Hongkong IoT Dashboard

**Made with ❤️ in Purwokerto, Indonesia**

[⬆ Kembali ke atas](#-smart-ulat-hongkong-iot-dashboard)

</div>
