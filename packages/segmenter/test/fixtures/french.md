Bonjour à tous. Le serveur de production est tombé hier soir à cause d'une migration mal préparée. Nous avons restauré la base de données depuis la sauvegarde de minuit, puis nous avons rejoué les transactions manquantes une par une. Aucune donnée client n'a été perdue, mais plusieurs commandes ont été retardées de quelques heures.

Pour éviter que cela se reproduise, nous allons ajouter une étape de validation avant chaque déploiement.
