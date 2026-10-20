from django.urls import path

from routing import views

urlpatterns = [
    path("api/health", views.health),
    path("api/geocode", views.geocode),
    path("api/routes/analyze", views.analyze),
    path("api/analyses/<str:analysis_id>/heatmap", views.heatmap),
]
