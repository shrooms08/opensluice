-- On-chain confirmation progress per observed event, so the public swap view
-- can say "confirming (2/3)" without asking the adapter. NULL for off-chain
-- events (they commit in one step).
ALTER TABLE leg_events ADD COLUMN confirmations INTEGER;
