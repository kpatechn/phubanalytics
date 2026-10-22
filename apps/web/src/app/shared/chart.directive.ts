import { DestroyRef, Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';
import { BarChart, LineChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { ChartTheme, type ChartTokens } from './chart-theme';

// Only what the dashboards use, to keep the lazy chunks small.
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, AriaComponent, CanvasRenderer]);

export type ChartOption = echarts.EChartsCoreOption;
/** Builds the option from theme tokens, so colors follow light/dark changes. */
export type ChartBuilder = (t: ChartTokens) => ChartOption;

/** The one place ECharts is called. Usage: <div [appChart]="builder" chartLabel="…"></div> */
@Directive({
  selector: '[appChart]',
  host: { role: 'img', '[attr.aria-label]': 'chartLabel()' },
})
export class ChartDirective {
  readonly appChart = input.required<ChartBuilder>();
  readonly chartLabel = input.required<string>();

  private chart: echarts.ECharts | null = null;

  constructor() {
    const host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    const theme = inject(ChartTheme);
    const resize = new ResizeObserver(() => this.chart?.resize());

    afterRenderEffect(() => {
      const tokens = theme.tokens();
      const option = this.appChart()(tokens);
      if (!this.chart) {
        this.chart = echarts.init(host, null, { renderer: 'canvas' });
        resize.observe(host);
      }
      this.chart.setOption(
        {
          animation: !tokens.reducedMotion,
          textStyle: { fontFamily: tokens.font, color: tokens.ink2 },
          aria: { enabled: true, label: { description: this.chartLabel() } },
          ...option,
        },
        { notMerge: true },
      );
    });

    inject(DestroyRef).onDestroy(() => {
      resize.disconnect();
      this.chart?.dispose();
      this.chart = null;
    });
  }
}

/** Shared axis and tooltip styling. */
export function baseChart(t: ChartTokens) {
  const axisLabel = { color: t.mute, fontSize: 11 };
  return {
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis' as const, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.ink, fontSize: 12 } },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2, fontSize: 12 } },
    categoryAxis: { axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false }, axisLabel },
    valueAxis: { splitLine: { lineStyle: { color: t.grid } }, axisLabel },
  };
}
