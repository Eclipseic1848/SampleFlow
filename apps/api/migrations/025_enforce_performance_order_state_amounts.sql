alter table performance_orders add constraint performance_orders_state_amounts_check check (
  lifecycle_state = 'historical_review_required'
  or (lifecycle_state = 'draft' and current_revenue = 0 and counted_amount = 0)
  or (lifecycle_state = 'active' and current_revenue > 0 and counted_amount > 0)
  or (lifecycle_state = 'paused' and current_revenue > 0 and counted_amount = 0)
  or (lifecycle_state = 'zero' and current_revenue = 0 and counted_amount = 0)
);
