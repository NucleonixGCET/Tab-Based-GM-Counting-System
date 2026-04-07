# Tab-Based GM Counting System

A professional, tablet-optimized radiation monitoring application designed for Nucleonix Scintillation Detectors. This system interfaces with Nordic nRF52810-based hardware via Bluetooth Low Energy (BLE) to provide real-time data acquisition, visualization, and persistent storage.

![App Interface Mockup](image.jpeg)

## 🌟 Key Features

- **Real-Time Data Acquisition**: Support for multiple counting modes:
  - **CPS**: Counts Per Second.
  - **CPM**: Counts Per Minute.
  - **Preset Time**: Accurate timing for fixed-duration measurements.
- **Professional Hardware Interface**: A high-fidelity dashboard mimicking industrial monitoring systems with dedicated panels for:
  - Digital Count Display
  - High Voltage (HV) Helipot Control (0-1200V)
  - Parameter Programming (PROG)
  - Pulse LED & Measurement Stability Indicators
- **Advanced Programming Workflow**:
  - Multi-iteration measurements (1-9 cycles).
  - Delta-HV (dHV) support for automatic voltage stepping between iterations.
  - Sample (SP), Standard (ST), and Background (BG) labeling.
- **Persistent Data Management**:
  - Integrated **SQLite** database for on-device storage.
  - Data Recall mode for reviewing past measurements.
  - CSV Export/Sharing via system share sheets.
- **BLE Connectivity**: Auto-discovery and connection to nRF52810 detectors using the Nordic UART Service.

## 🛠 Technology Stack

- **Core**: [React Native](https://reactnative.dev/) & [Expo](https://expo.dev/)
- **Bluetooth**: [react-native-ble-plx](https://github.com/dotintent/react-native-ble-plx)
- **Database**: [expo-sqlite](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- **File System & Sharing**: [expo-file-system](https://docs.expo.dev/versions/latest/sdk/filesystem/) & [expo-sharing](https://docs.expo.dev/versions/latest/sdk/sharing/)
- **UI Components**: Custom Vanilla CSS-in-JS for a premium industrial look.

## 📱 Hardware Integration

The application expects a detector running firmware compatible with the **Nordic UART Service**:
- **Service UUID**: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- **RX Characteristic**: `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` (Device to Phone)
- **Data Format**: ASCII string packets (e.g., `Cnts:127!`)

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- Expo Go app on your tablet (for development) OR a configured native build environment for Android/iOS.
- A compatible BLE Scintillation Detector.

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/NucleonixGCET/Tab-Based-GM-Counting-System.git
   cd Tab-Based-GM-Counting-System
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npx expo start
   ```

4. **Connect to hardware:**
   - Ensure Bluetooth and Location are enabled on your tablet.
   - Open the app and navigate to the **BLE Connection Screen**.
   - select your detector to enter the **Main Dashboard**.

## 📂 Project Structure

```text
├── assets/             # Branding and icons
├── components/         # Reusable UI elements (Panels, Buttons, etc.)
├── hooks/             # Custom hooks (BLE logic, Database, etc.)
├── screens/           # Main application screens (Connect, Main Dashboard)
├── App.js             # Root application logic and navigation
└── package.json       # Dependency manifest
```

## 📜 License

Internal Project for Nucleonix GCET. All rights reserved.

---
*Built with ❤️ for precision radiation measurement.*
