ALTER TABLE `finds` ADD `type` text DEFAULT 'event' NOT NULL;--> statement-breakpoint
ALTER TABLE `finds` ADD `business_id` integer REFERENCES businesses(id);