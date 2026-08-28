-- proof-link density: how many http(s) receipt links each resume carries
ALTER TABLE resumes ADD COLUMN receipts INTEGER NOT NULL DEFAULT 0;
