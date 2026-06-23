import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { supabase } from './supabaseClient';

/**
 * Get the device's unique identifier
 * On Android, uses Application.getAndroidId()
 * On other platforms, falls back to a generated ID
 */
export const getDeviceId = async () => {
  try {
    if (Platform.OS === 'android') {
      const androidId = Application.getAndroidId();
      console.log('Device ID read:', androidId);
      return androidId || 'UNKNOWN_ANDROID_ID';
    } else {
      // For iOS or other platforms, use a fallback
      const appId = Application.applicationId || 'UNKNOWN_DEVICE_ID';
      console.log('Device ID (non-Android):', appId);
      return appId;
    }
  } catch (error) {
    console.error('Error getting device ID:', error);
    return 'ERROR_GETTING_DEVICE_ID';
  }
};

/**
 * Check if the device ID is authorized in the GCS602t table
 * @param {string} deviceId - The device ID to check
 * @returns {Promise<{authorized: boolean, error: string | null}>}
 */
export const checkDeviceAuthorization = async (deviceId) => {
  try {
    const { data, error } = await supabase
      .from('GCS602t')
      .select('device_id')
      .eq('device_id', deviceId);

    if (error) {
      console.error('Supabase query error:', error);
      return { authorized: false, error: error.message };
    }

    console.log('Query result:', data);
    return { authorized: data && data.length > 0, error: null };
  } catch (error) {
    console.error('Error checking device authorization:', error);
    return { authorized: false, error: error.message };
  }
};

/**
 * Complete authentication flow: get device ID and check authorization
 * @returns {Promise<{authorized: boolean, deviceId: string, error: string | null}>}
 */
export const authenticateDevice = async () => {
  const deviceId = await getDeviceId();
  const { authorized, error } = await checkDeviceAuthorization(deviceId);
  
  return {
    authorized,
    deviceId,
    error,
  };
};
