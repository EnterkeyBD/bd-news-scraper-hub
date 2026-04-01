"""
Quick start script to set up and run event clustering
"""

import sys
import subprocess
from pathlib import Path

def check_dependencies():
    """Check if required packages are installed"""
    required = ['sentence_transformers', 'sklearn', 'rich']
    missing = []
    
    for package in required:
        try:
            __import__(package.replace('_', '-'))
        except ImportError:
            missing.append(package)
    
    return missing

def install_dependencies():
    """Install missing dependencies"""
    print("Installing required packages...")
    subprocess.check_call([
        sys.executable, "-m", "pip", "install",
        "sentence-transformers",
        "scikit-learn",
        "rich"
    ])
    print("✓ Dependencies installed!")

def setup_database():
    """Create clustering tables"""
    print("\nSetting up database tables...")
    import db_cluster
    db_cluster.create_clustering_tables()
    print("✓ Database setup complete!")

def run_initial_clustering():
    """Run initial clustering"""
    print("\nRunning initial clustering (24 hour window)...")
    print("This may take a few minutes on first run (downloading ML model)...\n")
    
    from cluster_service import EventClusteringService
    
    service = EventClusteringService(
        similarity_threshold=0.75,
        time_window_hours=24
    )
    
    stats = service.run_clustering()
    
    print("\n" + "="*60)
    print("Setup Complete!")
    print("="*60)
    print(f"Articles processed: {stats['articles_processed']}")
    print(f"Clusters created: {stats['clusters_created']}")
    print(f"Execution time: {stats['execution_time']:.2f}s")
    print("\nNext steps:")
    print("  1. View clusters: python view_clusters.py --list")
    print("  2. See details: python view_clusters.py --detail <cluster_id>")
    print("  3. Run again: python cluster_service.py --hours 24")
    print("="*60)

def main():
    print("="*60)
    print("Event Clustering System - Setup & First Run")
    print("="*60)
    print()
    
    # Check dependencies
    missing = check_dependencies()
    if missing:
        print(f"Missing packages: {', '.join(missing)}")
        response = input("Install now? (y/n): ")
        if response.lower() == 'y':
            install_dependencies()
        else:
            print("Please install required packages manually:")
            print("pip install sentence-transformers scikit-learn rich")
            return
    else:
        print("✓ All dependencies found")
    
    # Setup database
    try:
        setup_database()
    except Exception as e:
        print(f"Error setting up database: {e}")
        return
    
    # Run clustering
    try:
        response = input("\nRun initial clustering now? (y/n): ")
        if response.lower() == 'y':
            run_initial_clustering()
        else:
            print("\nSetup complete! Run clustering manually with:")
            print("python cluster_service.py --hours 24")
    except Exception as e:
        print(f"Error running clustering: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
