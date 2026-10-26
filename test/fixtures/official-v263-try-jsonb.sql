-- Upstream garrytan/gbrain v263, read at a6654ba50; compatibility fixture, not part of the fork registry.

CREATE OR REPLACE FUNCTION gbrain_try_jsonb(input text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $fn$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN data_exception THEN
  RETURN NULL;
END $fn$;
