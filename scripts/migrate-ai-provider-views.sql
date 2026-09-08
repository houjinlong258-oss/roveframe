-- RoveAgent Integration · AI Provider 管理命名视图
--
-- 蓝图要求的逻辑表：ai_providers / ai_credentials / ai_usage_logs。
-- RoveFrame 已有物理实现：model_configs（Provider 连接 + AES-256-GCM
-- 加密密钥）与 ai_usage_ledger（用量/成本台账）。本迁移只建只读视图
-- 提供蓝图命名，不新建平行表，避免双数据源。
--
-- 安全契约保持原样：
-- - 密钥永远以密文存储（crypto.ts AES-256-GCM），视图不解密、不新增暴露面。
-- - 继承底层表的 RLS 策略（tenant 隔离）。

DO $$
BEGIN
  IF to_regclass('public.model_configs') IS NOT NULL THEN
    EXECUTE '
      CREATE OR REPLACE VIEW public.ai_providers AS
      SELECT
        id,
        tenant_id,
        provider,
        COALESCE(display_name, provider) AS display_name,
        base_url,
        default_model,
        is_enabled,
        last_test_ok,
        last_tested_at,
        models_cache,
        models_updated_at
      FROM public.model_configs';

    EXECUTE '
      CREATE OR REPLACE VIEW public.ai_credentials AS
      SELECT
        id,
        tenant_id,
        provider,
        api_key_encrypted  -- 密文；解密只发生在服务端运行时内存
      FROM public.model_configs';
  END IF;

  IF to_regclass('public.ai_usage_ledger') IS NOT NULL THEN
    EXECUTE '
      CREATE OR REPLACE VIEW public.ai_usage_logs AS
      SELECT
        id,
        tenant_id,
        business_id,
        user_id,
        agent,
        provider,
        model,
        input_tokens,
        output_tokens,
        estimated_cost_usd,
        status,
        error_code,
        correlation_id,
        latency_ms,
        created_at
      FROM public.ai_usage_ledger';
  END IF;
END $$;
