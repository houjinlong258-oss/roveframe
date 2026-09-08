export interface ThemeCustomization {
  brandName: string;
  primaryColor: string;
  accentColor: string;
  nearBlack: string;
  warmOffWhite: string;
  borderRadius: string;
}

export const defaultThemeCustomization: ThemeCustomization = {
  brandName: 'ROVE/FRAME',
  primaryColor: '#0D0D0D',
  accentColor: '#A7FF00',
  nearBlack: '#0D0D0D',
  warmOffWhite: '#F7F5F0',
  borderRadius: '0.5rem',
};
