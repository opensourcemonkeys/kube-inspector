import { CardComponentProps } from 'nextstepjs';
import { Button } from 'primereact/button';
import { useT } from '../../i18n/useT';

export default function TourCard({
    step,
    currentStep,
    totalSteps,
    nextStep,
    prevStep,
    skipTour,
    arrow,
}: CardComponentProps) {
    const t = useT();
    const isLast = currentStep === totalSteps - 1;

    return (
        <div className="tour-card">
            <div className="tour-card__header">
                <div className="tour-card__title-row">
                    {step.icon && <span className="tour-card__icon">{step.icon}</span>}
                    <h3 className="tour-card__title">{step.title}</h3>
                </div>
            </div>

            <div className="tour-card__content">{step.content}</div>

            <div className="tour-card__footer">
                <span className="tour-card__counter">{t('panels:tour.stepOf', { current: currentStep + 1, total: totalSteps })}</span>
                {step.showControls && (
                    <span className="tour-card__nav">
                        {currentStep > 0 && (
                            <Button label={t('panels:tour.previous')} severity="secondary" size="small" onClick={prevStep} />
                        )}
                        <Button label={t(isLast ? 'panels:tour.finish' : 'panels:tour.next')} size="small" onClick={nextStep} />
                    </span>
                )}
            </div>

            {skipTour && !isLast && step.showSkip && (
                <Button className="tour-card__skip" label={t('panels:tour.skip')} text size="small" onClick={skipTour} />
            )}

            {arrow}
        </div>
    );
}
