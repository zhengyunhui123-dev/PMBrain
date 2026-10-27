export const BOUNDED_PAGE_SEARCH_SQL=`
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $fn$
DECLARE timeline_text TEXT;
BEGIN
  IF TG_OP='UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title
    AND NEW.compiled_truth IS NOT DISTINCT FROM OLD.compiled_truth
    AND NEW.timeline IS NOT DISTINCT FROM OLD.timeline THEN RETURN NEW; END IF;
  SELECT coalesce(string_agg(left(coalesce(summary,'')||' '||coalesce(detail,''),1024),' '),'') INTO timeline_text
    FROM (SELECT summary,detail FROM timeline_entries WHERE page_id=NEW.id ORDER BY id DESC LIMIT 8) AS recent;
  NEW.search_vector :=
    setweight(to_tsvector('english',left(coalesce(NEW.title,''),2048)),'A') ||
    setweight(to_tsvector('english',left(coalesce(NEW.compiled_truth,''),49152)),'B') ||
    setweight(to_tsvector('english',left(coalesce(NEW.timeline,''),4096)),'C') ||
    setweight(to_tsvector('english',left(coalesce(timeline_text,''),8192)),'C');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
`;
