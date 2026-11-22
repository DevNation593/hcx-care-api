-- Trigram indexes for the patient search.
--
-- PatientsService.findAll searches firstName, lastName, email, phone and identificationNumber
-- with `contains` (ILIKE / LIKE '%term%'), which no btree can serve: every search scanned all the
-- patients of the tenant. A GIN index with gin_trgm_ops serves those patterns. The planner can
-- combine the five indexes (BitmapOr) only because every OR branch of the search is indexed, so
-- all five columns are covered.
--
-- Additive only: one extension (if missing) and five indexes; no table or data is changed.
-- CREATE INDEX takes a SHARE lock on "Patient" while it builds (writes wait, reads do not); it is
-- a matter of seconds for tens of thousands of rows. Run it when the clinic is quiet.
--
-- Where pg_trgm lives: Supabase keeps extensions in the "extensions" schema, and a plain
-- PostgreSQL has no such schema. Everything is done inside one DO block, and only when something
-- is missing, because CREATE SCHEMA / CREATE EXTENSION check the CREATE privilege before they
-- look at IF NOT EXISTS: a role without that privilege would fail even when all of it exists.
--   * the schema "extensions" is created only if it does not exist;
--   * pg_trgm is created (in "extensions") only if it is not installed anywhere yet;
--   * the operator class is qualified with the schema where pg_trgm really is ("public" or
--     "extensions"), so gin_trgm_ops resolves whatever the search_path of the migration role is.
DO $$
DECLARE
  trgm_schema text;
  indexed_column text;
BEGIN
  SELECT n.nspname
    INTO trgm_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';

  IF trgm_schema IS NULL THEN
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
        CREATE SCHEMA extensions;
      END IF;
      CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'The patient search migration needs the pg_trgm extension and the current role cannot create it. Enable pg_trgm once with a privileged role (on Supabase: Database > Extensions, or CREATE EXTENSION pg_trgm WITH SCHEMA extensions;) and run the migration again.'
        USING ERRCODE = 'insufficient_privilege';
    END;
    trgm_schema := 'extensions';
  END IF;

  FOREACH indexed_column IN ARRAY ARRAY['firstName', 'lastName', 'email', 'phone', 'identificationNumber']
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON "Patient" USING GIN (%I %I.gin_trgm_ops)',
      'Patient_' || indexed_column || '_trgm_idx',
      indexed_column,
      trgm_schema
    );
  END LOOP;
END
$$;
