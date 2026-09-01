alter table performance_event_analysis_dimensions
  add column dimension_sequence bigint generated always as identity;

alter table performance_event_analysis_dimensions
  add constraint performance_event_analysis_dimensions_sequence_key unique(dimension_sequence);
