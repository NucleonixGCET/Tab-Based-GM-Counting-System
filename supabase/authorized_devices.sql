-- Create table for authorized devices
-- This table stores device IDs that are allowed to access the application

CREATE TABLE IF NOT EXISTS public."GCS602t" (
  device_id TEXT NOT NULL PRIMARY KEY
) TABLESPACE pg_default;

-- Enable Row Level Security (RLS)
ALTER TABLE public."GCS602t" ENABLE ROW LEVEL SECURITY;

-- Create policy to allow read access to all authenticated users
-- This allows the app to check if a device is authorized
CREATE POLICY "Allow read access to all"
  ON public."GCS602t"
  FOR SELECT
  TO public
  USING (true);

-- Create policy to allow insert access (for administrators to add devices)
-- You may want to restrict this further based on your authentication requirements
CREATE POLICY "Allow insert to authenticated"
  ON public."GCS602t"
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Create policy to allow update access (for administrators to manage devices)
CREATE POLICY "Allow update to authenticated"
  ON public."GCS602t"
  FOR UPDATE
  TO authenticated
  USING (true);

-- Create policy to allow delete access (for administrators to remove devices)
CREATE POLICY "Allow delete to authenticated"
  ON public."GCS602t"
  FOR DELETE
  TO authenticated
  USING (true);

-- Example: Add an authorized device
-- INSERT INTO public."GCS602t" (device_id) VALUES ('your-android-id-here');

-- Example: Query to check if a device is authorized
-- SELECT * FROM public."GCS602t" WHERE device_id = 'your-android-id-here';

-- Example: Remove an authorized device
-- DELETE FROM public."GCS602t" WHERE device_id = 'your-android-id-here';

-- Example: List all authorized devices
-- SELECT * FROM public."GCS602t";
