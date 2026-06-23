import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl || 'https://zcxfbhhvoeqohxnftjyp.supabase.co';
const supabaseKey = Constants.expoConfig?.extra?.supabaseKey || 'sb_publishable_x2bDceBOFdsTp1I71fPeGw_Y0Hwf2F6';

export const supabase = createClient(supabaseUrl, supabaseKey);
