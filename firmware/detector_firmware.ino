/**
 * ESP32 BLE Firmware Module for Scintillator Detector Control
 * 
 * Implements:
 * - Nordic UART Service (NUS) UUIDs to match the mobile application.
 * - Non-blocking delimiter-based ('!') command parser.
 * - Non-blocking data acquisition and streaming loop.
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ── BLE UUID Config (Nordic UART Service) ───────────────────────────
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E" // NUS Service
#define CHAR_UUID_RX           "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // Write (Phone -> Device)
#define CHAR_UUID_TX           "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // Notify (Device -> Phone)

// ── Hardware Pins ──────────────────────────────────────────────────
const int DETECTOR_PIN = 4;   // Pin connected to pulse output of GM tube/scintillator
const int HV_DAC_PIN   = 25;  // DAC pin to set High Voltage (ESP32 has DAC on 25 & 26)
const int HV_ADC_PIN   = 34;  // ADC pin to monitor actual high voltage output

// ── Global System State ────────────────────────────────────────────
bool isAcquiring = false;
volatile unsigned long pulseCount = 0;
unsigned long lastStreamTime = 0;
float currentHV_kV = 0.330;   // Measured HV in kV (e.g. 0.330 kV = 330V)
int targetHV_V = 400;         // Target HV in Volts

// Calibration Tables
const int MAX_CAL_POINTS = 32;
int hvTable[MAX_CAL_POINTS] = {0, 300, 330, 360, 390, 420, 450, 480, 510, 540, 570, 600, 630, 660, 690, 720, 750, 780, 810, 840};
int dacTable[MAX_CAL_POINTS] = {0, 1010, 1104, 1208, 1284, 1360, 1436, 1512, 1588, 1664, 1740, 1816, 1892, 1968, 2044, 2120, 2196, 2272, 2348, 2424};
int calPointsCount = 20;

// BLE Server components
BLEServer *pServer = nullptr;
BLECharacteristic *pTxCharacteristic = nullptr;
bool deviceConnected = false;
String cmdBuffer = "";

// ── Interrupt Service Routine (ISR) for Detector Pulses ───────────
void IRAM_ATTR onDetectorPulse() {
  pulseCount++;
}

// ── High Voltage Control Function ──────────────────────────────────
void updateHighVoltage(int targetVoltage) {
  targetHV_V = targetVoltage;
  int dacValue = 0;
  
  // Search for targetVoltage in the hvTable
  int foundIndex = -1;
  for (int i = 0; i < calPointsCount; i++) {
    if (hvTable[i] == targetVoltage) {
      foundIndex = i;
      break;
    }
  }
  
  if (foundIndex != -1) {
    dacValue = dacTable[foundIndex];
    // If table value is 12-bit (0-4095), map to 8-bit (0-255) for the ESP32 internal DAC
    int espDacValue = dacValue;
    if (dacValue > 255) {
      espDacValue = (dacValue * 255) / 4095;
    }
    dacWrite(HV_DAC_PIN, constrain(espDacValue, 0, 255));
    Serial.printf("[SYSTEM] HV Target updated to: %d V (Table Match index: %d, Table DAC: %d, ESP DAC: %d)\n", targetVoltage, foundIndex, dacValue, espDacValue);
  } else {
    // Fallback to linear mapping if not in table
    dacValue = map(targetVoltage, 0, 1500, 0, 255);
    dacWrite(HV_DAC_PIN, constrain(dacValue, 0, 255));
    Serial.printf("[SYSTEM] HV Target updated to: %d V (Fallback linear DAC: %d)\n", targetVoltage, dacValue);
  }
}

// ── Read Actual High Voltage from Feedback Loop ────────────────────
float readActualHV_kV() {
  // Read analog feedback and convert back to kV
  int adcVal = analogRead(HV_ADC_PIN);
  
  // Example Conversion: 12-bit ADC (0-4095) with division ratio.
  // Replace this calibration with your actual divider network values:
  float measuredV = (adcVal / 4095.0) * 3.3 * 500.0; // scale factor
  currentHV_kV = measuredV / 1000.0; // convert to kV
  
  return currentHV_kV;
}

// ── Command Processor ──────────────────────────────────────────────
void processCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  Serial.print("[BLE CMD] Processing: ");
  Serial.println(cmd);

  if (cmd.equals("SRTC")) {
    // Start acquisition
    isAcquiring = true;
    pulseCount = 0;
    lastStreamTime = millis();
    Serial.println("[SYSTEM] Acquisition Started.");
  }
  else if (cmd.equals("STPC")) {
    // Stop acquisition
    isAcquiring = false;
    Serial.println("[SYSTEM] Acquisition Stopped.");
  }
  else if (cmd.startsWith("STHV")) {
    // Parse target HV: e.g. "STHV 300"
    int spaceIndex = cmd.indexOf(' ');
    if (spaceIndex != -1) {
      String valStr = cmd.substring(spaceIndex + 1);
      int requestedHV = valStr.toInt();
      if (requestedHV >= 0 && requestedHV <= 1500) {
        updateHighVoltage(requestedHV);
      } else {
        Serial.println("[SYSTEM] Error: HV out of range (0-1500V).");
      }
    }
  }
  else if (cmd.startsWith("UDHV")) {
    // Parse uploaded HV table: e.g. "UDHV 0,300,330,..."
    int startIdx = 4;
    while (startIdx < cmd.length() && (cmd[startIdx] == ' ' || cmd[startIdx] == '\t')) {
      startIdx++;
    }
    String listStr = cmd.substring(startIdx);
    int count = 0;
    int fromIdx = 0;
    while (fromIdx < listStr.length() && count < MAX_CAL_POINTS) {
      int commaIdx = listStr.indexOf(',', fromIdx);
      String valStr;
      if (commaIdx != -1) {
        valStr = listStr.substring(fromIdx, commaIdx);
        fromIdx = commaIdx + 1;
      } else {
        valStr = listStr.substring(fromIdx);
        fromIdx = listStr.length();
      }
      valStr.trim();
      if (valStr.length() > 0) {
        hvTable[count++] = valStr.toInt();
      }
    }
    calPointsCount = count;
    Serial.printf("[SYSTEM] Uploaded HV Table with %d points.\n", calPointsCount);
  }
  else if (cmd.startsWith("UDAC")) {
    // Parse uploaded DAC table: e.g. "UDAC 0,1010,1104,..."
    int startIdx = 4;
    while (startIdx < cmd.length() && (cmd[startIdx] == ' ' || cmd[startIdx] == '\t')) {
      startIdx++;
    }
    String listStr = cmd.substring(startIdx);
    int count = 0;
    int fromIdx = 0;
    while (fromIdx < listStr.length() && count < MAX_CAL_POINTS) {
      int commaIdx = listStr.indexOf(',', fromIdx);
      String valStr;
      if (commaIdx != -1) {
        valStr = listStr.substring(fromIdx, commaIdx);
        fromIdx = commaIdx + 1;
      } else {
        valStr = listStr.substring(fromIdx);
        fromIdx = listStr.length();
      }
      valStr.trim();
      if (valStr.length() > 0) {
        dacTable[count++] = valStr.toInt();
      }
    }
    Serial.printf("[SYSTEM] Uploaded DAC Table with %d points.\n", count);
  }
  else if (cmd.equals("DDHV")) {
    // Send stored HV Table
    String response = "DDHV:";
    for (int i = 0; i < calPointsCount; i++) {
      response += String(hvTable[i]);
      if (i < calPointsCount - 1) {
        response += ",";
      }
    }
    response += "!\r\n";
    if (deviceConnected && pTxCharacteristic != nullptr) {
      pTxCharacteristic->setValue((uint8_t*)response.c_str(), response.length());
      pTxCharacteristic->notify();
      Serial.print("[BLE SENT] ");
      Serial.print(response);
    }
  }
  else if (cmd.equals("DDAC")) {
    // Send stored DAC Table
    String response = "DDAC:";
    for (int i = 0; i < calPointsCount; i++) {
      response += String(dacTable[i]);
      if (i < calPointsCount - 1) {
        response += ",";
      }
    }
    response += "!\r\n";
    if (deviceConnected && pTxCharacteristic != nullptr) {
      pTxCharacteristic->setValue((uint8_t*)response.c_str(), response.length());
      pTxCharacteristic->notify();
      Serial.print("[BLE SENT] ");
      Serial.print(response);
    }
  }
  else {
    Serial.print("[SYSTEM] Unknown Command: ");
    Serial.println(cmd);
  }
}

// ── BLE Server Callbacks ───────────────────────────────────────────
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("[BLE] Client Connected.");
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      isAcquiring = false;
      Serial.println("[BLE] Client Disconnected. Stopping stream.");
      // Restart advertising to allow re-connection
      delay(500); // give the bluetooth stack the chance to get ready
      pServer->startAdvertising();
      Serial.println("[BLE] Advertising restarted.");
    }
};

// ── BLE Rx Callback (Processes data sent from client) ──────────────
class MyCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      std::string rxValue = pCharacteristic->getValue();
      if (rxValue.length() > 0) {
        for (int i = 0; i < rxValue.length(); i++) {
          char c = rxValue[i];
          if (c == '!') {
            // End of command packet, process buffer
            processCommand(cmdBuffer);
            cmdBuffer = ""; // Reset buffer
          } else {
            cmdBuffer += c;
          }
        }
      }
    }
};

// ── Main Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // Setup Hardware Pin Modes
  pinMode(DETECTOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(DETECTOR_PIN), onDetectorPulse, FALLING);
  pinMode(HV_ADC_PIN, INPUT);

  // Set initial HV target
  updateHighVoltage(targetHV_V);

  // Initialize BLE Device
  // Name includes '52810' to align with the application auto-connect target
  BLEDevice::init("ESP32-52810-Detector");

  // Create Server
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // Create UART Service
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Create Tx (Notify) Characteristic for streaming data
  pTxCharacteristic = pService->createCharacteristic(
                        CHAR_UUID_TX,
                        BLECharacteristic::PROPERTY_NOTIFY
                      );
  pTxCharacteristic->addDescriptor(new BLE2902());

  // Create Rx (Write) Characteristic for command parsing
  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
                                           CHAR_UUID_RX,
                                           BLECharacteristic::PROPERTY_WRITE |
                                           BLECharacteristic::PROPERTY_WRITE_NR
                                         );
  pRxCharacteristic->setCallbacks(new MyCallbacks());

  // Start the service
  pService->start();

  // Start advertising
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);  // functions for iPhone connections issue
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("[BLE] BLE initialized. Waiting for connections...");
}

// ── Main Loop ──────────────────────────────────────────────────────
void loop() {
  // If connected and acquisition is running, stream detector data every 1 second
  if (deviceConnected && isAcquiring) {
    unsigned long currentMillis = millis();
    if (currentMillis - lastStreamTime >= 1000) {
      lastStreamTime = currentMillis;

      // Read actual high voltage from sensor
      float actualHV = readActualHV_kV();

      // Read cumulative pulse count in the last second and reset pulse counter
      noInterrupts();
      unsigned long countsThisSecond = pulseCount;
      pulseCount = 0;
      interrupts();

      // Package data in format: "Counts,<counts>,CurHV,<kV_val>!\r\n"
      char txBuffer[64];
      snprintf(txBuffer, sizeof(txBuffer), "Counts,%lu,CurHV,%.3f!\r\n", countsThisSecond, actualHV);
      
      // Send data to connected device
      pTxCharacteristic->setValue((uint8_t*)txBuffer, strlen(txBuffer));
      pTxCharacteristic->notify();
      
      Serial.print("[DATA SENT] ");
      Serial.print(txBuffer);
    }
  }

  // Non-blocking processing of other background tasks can go here
  delay(10); // yields execution to support BLE stack
}
