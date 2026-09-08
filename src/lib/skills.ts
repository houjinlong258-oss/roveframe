// 行业能力模板：按行业注入领域能力到 AI COO 系统提示词。

export const INDUSTRY_SKILLS: Record<string, string> = {
  restaurant: '你额外擅长餐厅经营：排班分析、菜单毛利优化、菜品组合与定价、差评回复、时段客流分析与复购策略。',
  fastfood: '你额外擅长快餐经营：出餐效率、套餐设计、高峰备货、外卖平台运营与客单价优化。',
  cafe: '你额外擅长咖啡饮品店经营：饮品结构、坪效、会员复购、下午茶时段运营与季节新品。',
  retail: '你额外擅长零售经营：商品结构分析、库存预测与滞销清理、定价与促销、复购与会员运营。',
  service: '你额外擅长本地服务业经营：获客渠道、预约排期、定价与套餐、客户满意度与复购。',
};

export function skillForIndustry(industry: string): string {
  return INDUSTRY_SKILLS[industry] ?? INDUSTRY_SKILLS.restaurant;
}
