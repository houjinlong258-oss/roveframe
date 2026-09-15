# tool_policy_inventory

Phase 9 / Task 1 Tool Policy Closure 的实测清单。

生成方式（可复现）：

```bash
PYTHONPATH=. python -B <本文件的生成脚本>
```

发现路径为生产入口 `roveagent.model_tools`（触发 `discover_builtin_tools()` 与 `discover_plugins()`），因此清单与运行时实际注册表一致，而非静态猜测。

- 已注册工具：**101**
- 仅命中兜底行（= 改造前免权限免审批直执）：**0**
- 显式策略行数（不含兜底）：**99**

| tool | source(toolset) | risk | permission | approval | policy |
|---|---|---|---|---|---|
| `analyze_churn_customers` | business | LOW | — | none | explicit:analyze_churn_customers |
| `annotate_preview` | desktop_ui | LOW | — | none | explicit:annotate_preview |
| `apply_layout` | desktop_ui | LOW | — | none | explicit:apply_layout |
| `browser_back` | browser | LOW | — | none | explicit:browser_back |
| `browser_cdp` | browser-cdp | CRITICAL | — | manager | explicit:browser_cdp |
| `browser_click` | browser | MEDIUM | — | none | explicit:browser_click |
| `browser_console` | browser | LOW | — | none | explicit:browser_console |
| `browser_dialog` | browser-cdp | MEDIUM | — | none | explicit:browser_dialog |
| `browser_exec` | browser-use | CRITICAL | — | manager | explicit:browser_exec |
| `browser_get_images` | browser | LOW | — | none | explicit:browser_get_images |
| `browser_navigate` | browser | MEDIUM | — | none | explicit:browser_navigate |
| `browser_press` | browser | MEDIUM | — | none | explicit:browser_press |
| `browser_scroll` | browser | LOW | — | none | explicit:browser_scroll |
| `browser_snapshot` | browser | LOW | — | none | explicit:browser_snapshot |
| `browser_type` | browser | MEDIUM | — | none | explicit:browser_type |
| `browser_vision` | browser | LOW | — | none | explicit:browser_vision |
| `clarify` | clarify | LOW | — | none | explicit:clarify |
| `close_terminal` | desktop_ui | HIGH | — | manager | explicit:close_terminal |
| `computer_use` | computer_use | CRITICAL | — | manager | explicit:computer_use |
| `cronjob` | cronjob | HIGH | — | manager | explicit:cronjob |
| `delegate_task` | delegation | HIGH | — | manager | explicit:delegate_task |
| `desktop_preview` | desktop_ui | LOW | — | none | explicit:desktop_preview |
| `desktop_project` | project | LOW | — | none | explicit:desktop_project |
| `discord` | discord | MEDIUM | — | manager | explicit:discord |
| `discord_admin` | discord_admin | HIGH | — | manager | explicit:discord_admin |
| `drive_preview` | desktop_ui | LOW | — | none | explicit:drive_preview |
| `execute_code` | code_execution | CRITICAL | — | manager | explicit:execute_code |
| `feishu_doc_read` | feishu_doc | LOW | — | none | explicit:feishu_doc_read |
| `feishu_drive_add_comment` | feishu_drive | MEDIUM | — | none | explicit:feishu_drive_add_comment |
| `feishu_drive_list_comment_replies` | feishu_drive | LOW | — | none | explicit:feishu_drive_list_* |
| `feishu_drive_list_comments` | feishu_drive | LOW | — | none | explicit:feishu_drive_list_* |
| `feishu_drive_reply_comment` | feishu_drive | MEDIUM | — | none | explicit:feishu_drive_reply_comment |
| `focus_pane` | desktop_ui | LOW | — | none | explicit:focus_pane |
| `ha_call_service` | homeassistant | HIGH | — | manager | explicit:ha_call_service |
| `ha_get_state` | homeassistant | LOW | — | none | explicit:ha_get_state |
| `ha_list_entities` | homeassistant | LOW | — | none | explicit:ha_list_* |
| `ha_list_services` | homeassistant | LOW | — | none | explicit:ha_list_* |
| `image_generate` | image_gen | MEDIUM | — | manager | explicit:image_generate |
| `kanban_attach` | kanban | MEDIUM | — | none | explicit:kanban_attach |
| `kanban_attach_url` | kanban | MEDIUM | — | none | explicit:kanban_attach_url |
| `kanban_attachments` | kanban | LOW | — | none | explicit:kanban_attachments |
| `kanban_block` | kanban | MEDIUM | — | none | explicit:kanban_block |
| `kanban_comment` | kanban | MEDIUM | — | none | explicit:kanban_comment |
| `kanban_complete` | kanban | MEDIUM | — | none | explicit:kanban_complete |
| `kanban_create` | kanban | MEDIUM | — | none | explicit:kanban_create |
| `kanban_heartbeat` | kanban | LOW | — | none | explicit:kanban_heartbeat |
| `kanban_link` | kanban | MEDIUM | — | none | explicit:kanban_link |
| `kanban_list` | kanban | LOW | — | none | explicit:kanban_list |
| `kanban_request_changes` | kanban | MEDIUM | — | none | explicit:kanban_request_changes |
| `kanban_request_review` | kanban | MEDIUM | — | none | explicit:kanban_request_review |
| `kanban_show` | kanban | LOW | — | none | explicit:kanban_show |
| `kanban_unblock` | kanban | MEDIUM | — | none | explicit:kanban_unblock |
| `memory` | memory | MEDIUM | — | none | explicit:memory |
| `patch` | file | HIGH | files:write | manager | explicit:patch |
| `process` | terminal | HIGH | admin:process | manager | explicit:process |
| `react_to_message` | desktop_ui | MEDIUM | comms:send | manager | explicit:*message* |
| `read_business_profile` | business | LOW | settings:read | none | explicit:read_business_profile |
| `read_customers` | business | LOW | customers:read | none | explicit:read_customers |
| `read_file` | file | LOW | files:read | none | explicit:read_file |
| `read_inventory` | business | LOW | inventory:read | none | explicit:read_inventory |
| `read_orders` | business | LOW | orders:read | none | explicit:read_orders |
| `read_payments` | business | LOW | payments:read | none | explicit:read_payments |
| `read_products` | business | LOW | products:read | none | explicit:read_products |
| `read_reviews` | business | LOW | reviews:read | none | explicit:read_reviews |
| `read_sales` | business | LOW | orders:read | none | explicit:read_sales |
| `read_terminal` | desktop_ui | LOW | analytics:read | none | explicit:read_* |
| `read_window_below` | desktop_ui | LOW | analytics:read | none | explicit:read_* |
| `search_files` | file | LOW | files:read | none | explicit:search_files |
| `search_knowledge` | knowledge | LOW | knowledge:read | none | explicit:search_knowledge |
| `send_customer_recovery_campaign` | business | HIGH | comms:send | owner | explicit:send_customer_recovery_campaign |
| `session_search` | session_search | LOW | — | none | explicit:session_search |
| `setup_mcp` | desktop_ui | HIGH | — | owner | explicit:setup_mcp |
| `skill_manage` | skills | HIGH | — | manager | explicit:skill_manage |
| `skill_view` | skills | LOW | — | none | explicit:skill_view |
| `skills_list` | skills | LOW | — | none | explicit:skills_list |
| `spotify_albums` | spotify | LOW | — | none | explicit:spotify_* |
| `spotify_devices` | spotify | LOW | — | none | explicit:spotify_* |
| `spotify_library` | spotify | LOW | — | none | explicit:spotify_* |
| `spotify_playback` | spotify | LOW | — | none | explicit:spotify_* |
| `spotify_playlists` | spotify | LOW | — | none | explicit:spotify_* |
| `spotify_queue` | spotify | LOW | — | none | explicit:spotify_* |
| `spotify_search` | spotify | LOW | — | none | explicit:spotify_* |
| `terminal` | terminal | HIGH | admin:process | manager | explicit:terminal |
| `text_to_speech` | tts | LOW | — | none | explicit:text_to_speech |
| `tip` | desktop_ui | LOW | — | none | explicit:tip |
| `todo` | todo | LOW | — | none | explicit:todo |
| `tour` | desktop_ui | LOW | — | none | explicit:tour |
| `video_analyze` | video | LOW | — | none | explicit:video_analyze |
| `video_generate` | video_gen | MEDIUM | — | manager | explicit:video_generate |
| `vision_analyze` | vision | LOW | — | none | explicit:vision_analyze |
| `web_extract` | web | LOW | — | none | explicit:web_extract |
| `web_search` | web | LOW | — | none | explicit:web_search |
| `write_file` | file | HIGH | files:write | manager | explicit:write_file |
| `x_search` | x_search | LOW | — | none | explicit:x_search |
| `xai_video_edit` | video_gen | MEDIUM | — | manager | explicit:xai_video_edit |
| `xai_video_extend` | video_gen | MEDIUM | — | manager | explicit:xai_video_extend |
| `yb_query_group_info` | roveagent-yuanbao | LOW | — | none | explicit:yb_query_group_info |
| `yb_query_group_members` | roveagent-yuanbao | LOW | — | none | explicit:yb_query_group_members |
| `yb_search_sticker` | roveagent-yuanbao | LOW | — | none | explicit:yb_search_sticker |
| `yb_send_dm` | roveagent-yuanbao | HIGH | — | manager | explicit:yb_send_dm |
| `yb_send_sticker` | roveagent-yuanbao | HIGH | — | manager | explicit:yb_send_sticker |

## 兜底行

| pattern | risk | permission | approval | 语义 |
|---|---|---|---|---|
| `*` | HIGH | — | admin | **DENY**（authorize 见到兜底即拒绝）|
