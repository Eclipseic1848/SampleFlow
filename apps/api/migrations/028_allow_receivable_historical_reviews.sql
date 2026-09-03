alter table historical_order_reviews
  drop constraint historical_order_reviews_proposed_lifecycle_state_check,
  drop constraint historical_order_reviews_proposed_current_revenue_check,
  drop constraint historical_review_state_revenue;

alter table historical_order_reviews
  add constraint historical_review_lifecycle_state_check
    check (proposed_lifecycle_state in ('active','paused','zero','receivable_pending')),
  add constraint historical_review_state_revenue check (
    (proposed_lifecycle_state='zero' and proposed_current_revenue=0)
    or (proposed_lifecycle_state in ('active','paused') and proposed_current_revenue>0)
    or (proposed_lifecycle_state='receivable_pending' and proposed_current_revenue<0)
  );
