import React from 'react';
import { View, Text, StyleSheet, StatusBar, ScrollView } from 'react-native';

const UnauthorizedScreen = ({ deviceId, error }) => {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <Text style={styles.icon}>🔒</Text>
          <Text style={styles.title}>Access Denied</Text>
          <Text style={styles.message}>
            This device is not allowed to access the app.
          </Text>
          <Text style={styles.subMessage}>
            Please contact your administrator to authorize this device.
          </Text>
          
          <View style={styles.deviceIdContainer}>
            <Text style={styles.deviceIdLabel}>Device ID:</Text>
            <Text style={styles.deviceIdValue}>{deviceId}</Text>
          </View>
          
          {error && (
            <Text style={styles.errorText}>Error: {error}</Text>
          )}
          
          <Text style={styles.instruction}>
            Share this Device ID with your administrator to add it to the authorized devices list.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  icon: {
    fontSize: 80,
    marginBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#ff4757',
    marginBottom: 16,
    textAlign: 'center',
  },
  message: {
    fontSize: 18,
    color: '#ffffff',
    marginBottom: 12,
    textAlign: 'center',
  },
  subMessage: {
    fontSize: 14,
    color: '#a0a0a0',
    textAlign: 'center',
    marginBottom: 24,
  },
  deviceIdContainer: {
    backgroundColor: '#0d1e2e',
    borderWidth: 2,
    borderColor: '#3a8aaa',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    minWidth: 280,
  },
  deviceIdLabel: {
    fontSize: 12,
    color: '#7aaccc',
    marginBottom: 8,
    textAlign: 'center',
  },
  deviceIdValue: {
    fontSize: 16,
    color: '#c8e8ff',
    fontWeight: 'bold',
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  errorText: {
    fontSize: 12,
    color: '#ff6b6b',
    textAlign: 'center',
    marginBottom: 12,
  },
  instruction: {
    fontSize: 13,
    color: '#4a7a9a',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});

export default UnauthorizedScreen;
